#!/usr/bin/env bash
# Sets up this app on a fresh Ubuntu/Debian VPS: Node, Python, the app's
# own dependencies, the Hindi Piper voice model, and systemd services for
# both the Node app and the Python speech microservice.
#
# Run from the repo root: bash deploy/setup.sh
# Optionally pass a domain that already points at this VPS's IP to also
# set up nginx + a free TLS cert for it:
#   bash deploy/setup.sh voice.codebunny.net
#
# This does NOT install or configure Asterisk - that's a separate, optional
# step (see the main README) only needed once you're ready to take real
# phone calls. The browser dashboard works without Asterisk at all - and
# needs HTTPS (not a bare IP/HTTP) for microphone access to work, which is
# exactly what passing a domain here sets up.
set -euo pipefail

DOMAIN="${1:-}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"
SERVICE_USER="$(whoami)"

echo "==> Installing system packages"
sudo apt-get update
# mecab/libmecab-dev: build dependency of fugashi, which MeloTTS pulls in
# for Japanese tokenization even though we only use it for English/Hindi.
sudo apt-get install -y curl git python3 python3-venv python3-pip build-essential \
  mecab libmecab-dev mecab-ipadic-utf8

# MeloTTS pins transformers==4.27.4, which caps tokenizers<0.14 - and the
# newest version in that range (0.13.3) has no prebuilt wheel for Python
# 3.12+ on PyPI at all, forcing a from-source build. That build needs a
# Rust toolchain, but there's no single rustc version that works: it
# needs a *newer* one for one of its own dependencies (clap_lex requires
# the edition2024 cargo feature) while its *own* source code fails to
# compile on that same newer rustc (stricter lifetime checks than existed
# when 0.13.3 was published in 2023). Rather than fight that, give the
# tts-service venv its own Python 3.11 (via uv, which installs a portable
# build - no distro package repo involved) so pip picks tokenizers'
# existing prebuilt wheel instead of ever trying to compile it.
if ! command -v uv >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/uv" ]; then
  echo "==> Installing uv (to get a Python 3.11 independent of the OS)"
  curl -LsSf https://astral.sh/uv/install.sh | sh
fi
export PATH="$HOME/.local/bin:$PATH"
uv python install 3.11
PYTHON_3_11="$(uv python find 3.11)"

if ! command -v node >/dev/null 2>&1; then
  echo "==> Installing Node.js 22.x"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

echo "==> Installing Node dependencies and building"
npm install
npm run build

echo "==> Setting up tts-service (Python 3.11 venv)"
cd "$REPO_DIR/tts-service"
if [ ! -d .venv ]; then
  "$PYTHON_3_11" -m venv .venv
fi
./.venv/bin/pip install --upgrade pip
./.venv/bin/pip install -r requirements.txt
# CPU-only torch build - the default PyPI wheel pulls several GB of CUDA
# libraries (nvidia-*) nothing here uses, since this whole project runs
# CPU-only. Installing it first means MeloTTS's own install (next line,
# which otherwise pulls the GPU build as a dependency) finds it already
# satisfied and leaves it alone.
./.venv/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu
./.venv/bin/pip install git+https://github.com/myshell-ai/MeloTTS.git
# unidic download pulls a ~530MB dictionary with no built-in skip-if-
# present check of its own - guard it so re-running this script doesn't
# redownload it every time.
if ! ./.venv/bin/python -c "import unidic, os, sys; sys.exit(0 if os.listdir(unidic.DICDIR) else 1)" 2>/dev/null; then
  ./.venv/bin/python -m unidic download
fi

mkdir -p models
echo "==> Downloading Piper Hindi voice models (pratham, priyamvada)"
for voice in pratham priyamvada; do
  if [ ! -f "models/hi_IN-${voice}-medium.onnx" ]; then
    curl -L -o "models/hi_IN-${voice}-medium.onnx" \
      "https://huggingface.co/rhasspy/piper-voices/resolve/main/hi/hi_IN/${voice}/medium/hi_IN-${voice}-medium.onnx"
    curl -L -o "models/hi_IN-${voice}-medium.onnx.json" \
      "https://huggingface.co/rhasspy/piper-voices/resolve/main/hi/hi_IN/${voice}/medium/hi_IN-${voice}-medium.onnx.json"
  fi
done
cd "$REPO_DIR"

if [ ! -f .env ]; then
  echo "==> Creating .env from .env.example"
  cp .env.example .env
  TOKEN="$(openssl rand -hex 24)"
  sed -i "s/^ADMIN_TOKEN=.*/ADMIN_TOKEN=${TOKEN}/" .env
  echo "    Generated a random ADMIN_TOKEN for you: ${TOKEN}"
fi

echo "==> Installing systemd services (voice-agent, voice-speech)"
sed -e "s#__REPO_DIR__#${REPO_DIR}#g" -e "s#__SERVICE_USER__#${SERVICE_USER}#g" \
  deploy/voice-agent.service | sudo tee /etc/systemd/system/voice-agent.service >/dev/null
sed -e "s#__REPO_DIR__#${REPO_DIR}#g" -e "s#__SERVICE_USER__#${SERVICE_USER}#g" \
  deploy/voice-speech.service | sudo tee /etc/systemd/system/voice-speech.service >/dev/null
sudo systemctl daemon-reload

if [ -n "$DOMAIN" ]; then
  APP_PORT="$(grep '^PORT=' .env | cut -d= -f2 || true)"
  APP_PORT="${APP_PORT:-3000}"

  echo "==> Installing nginx + certbot for ${DOMAIN}"
  sudo apt-get install -y nginx certbot python3-certbot-nginx

  sed -e "s/__DOMAIN__/${DOMAIN}/g" -e "s/__PORT__/${APP_PORT}/g" \
    deploy/nginx.conf.template | sudo tee "/etc/nginx/sites-available/${DOMAIN}" >/dev/null
  sudo ln -sf "/etc/nginx/sites-available/${DOMAIN}" "/etc/nginx/sites-enabled/${DOMAIN}"
  sudo nginx -t
  sudo systemctl reload nginx

  if command -v ufw >/dev/null 2>&1; then
    sudo ufw allow "Nginx Full" || true
  fi

  echo "==> Requesting a TLS certificate for ${DOMAIN}"
  echo "    (requires ${DOMAIN} already pointing at this server's public IP)"
  sudo certbot --nginx -d "$DOMAIN" --redirect --non-interactive --agree-tos \
    --register-unsafely-without-email || {
    echo "    certbot failed - you can re-run it manually later:"
    echo "    sudo certbot --nginx -d ${DOMAIN} --redirect"
  }
fi

echo
echo "Setup done. Still needed before starting:"
echo "  1. Edit .env and set OPENAI_API_KEY (ADMIN_TOKEN was generated for you)."
echo "  2. sudo systemctl enable --now voice-speech"
echo "  3. sudo systemctl enable --now voice-agent"
if [ -n "$DOMAIN" ]; then
  echo "  4. Open https://${DOMAIN}/?token=<the ADMIN_TOKEN from .env>"
else
  echo "  4. Reach the dashboard via an SSH tunnel (recommended, see README) or"
  echo "     open the firewall per the README if you want it directly reachable."
  echo "     Or re-run this script with a domain already pointed at this VPS"
  echo "     to set up HTTPS automatically: bash deploy/setup.sh yourdomain.com"
fi
