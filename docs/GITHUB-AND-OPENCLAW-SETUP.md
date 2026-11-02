# Publishing and deploying: end-to-end checklist

## 1. Extract and inspect

Unzip the bundle in `~/Documents/Projects/openclaw-colab-provisioner` on your Ubuntu OpenClaw host. Check the files before publishing:

```bash
cd ~/Documents/Projects/openclaw-colab-provisioner
npm test
npm run check
find . -maxdepth 3 -type f | sort
```

## 2. Create the GitHub repository and push

Use GitHub CLI (install `gh` and authenticate with `gh auth login` first):

```bash
cd ~/Documents/Projects/openclaw-colab-provisioner
git init
git branch -M main
git add .
git commit -m "Initial Colab Provisioner community beta v1"
gh repo create openclaw-colab-provisioner --public --source=. --remote=origin --push
```

If you already created an empty repository on GitHub, instead use:

```bash
git remote add origin https://github.com/YOUR_USERNAME/openclaw-colab-provisioner.git
git push -u origin main
```

Do not run both remote-creation flows. If the repo already has commits, fetch/review them instead of forcing a push. Verify: `git status` and browse the GitHub README.

## 3. Install into OpenClaw from GitHub

```bash
openclaw plugins install git:github.com/YOUR_USERNAME/openclaw-colab-provisioner@main
openclaw plugins enable colab-provisioner
openclaw config set plugins.entries.colab-provisioner.config.mode observe
openclaw config set plugins.entries.colab-provisioner.config.telegramCommands false
openclaw plugins inspect colab-provisioner --runtime --json
openclaw plugins doctor
```

If the Gateway is stopped: `systemctl --user start openclaw-gateway`. An already running Gateway generally loads plugin changes automatically. No need to modify Smart Router.

## 4. Configure Google access and test without GPU use

Clone the repo for the CLI. Obtain a short-lived Google OAuth access token with scope `https://www.googleapis.com/auth/colaboratory` using a Google-approved interactive OAuth flow, then:

```bash
cd ~/Documents/Projects/openclaw-colab-provisioner
read -rsp 'Colab OAuth token: ' COLAB_ACCESS_TOKEN; echo
export COLAB_ACCESS_TOKEN
node bin/colabctl.mjs specs
node bin/colabctl.mjs list
unset COLAB_ACCESS_TOKEN
```

If API access fails, stop here and inspect the scope, Cloud project/API enablement, and account eligibility. Do not try to work around access restrictions.

## 5. Only if you are eligible: allocate and deallocate

```bash
node bin/colabctl.mjs specs
node bin/colabctl.mjs create --spec 0 --confirm-create
node bin/colabctl.mjs list
node bin/colabctl.mjs delete runtimes/YOUR_RUNTIME_ID --confirm-delete
```

Re-export a valid token first. Replace spec index and runtime ID with actual returned values. Do not delete a runtime you want to retain. No automatic idle termination exists in this version.

## 6. Optional Telegram help command

```bash
openclaw config set plugins.entries.colab-provisioner.config.mode manual
openclaw config set plugins.entries.colab-provisioner.config.telegramCommands true
openclaw config set plugins.entries.colab-provisioner.config.allowedTelegramIds '["YOUR_TELEGRAM_USER_ID"]'
```

Message `!colab status`. The plugin replies with operator CLI instructions, without making a Colab API request.

## 7. Recovery

Disable the plugin without affecting Smart Router:

```bash
openclaw plugins disable colab-provisioner
openclaw plugins doctor
```

Do not delete OpenClaw's state SQLite database or any existing agent configuration.
