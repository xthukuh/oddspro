# Owner manual tasks (2026-10-10)

Tasks only you can do. Each has the why, the steps and a check that proves it worked.
Tick a box when it is done and tell Claude the item number. Claude picks up the
follow-on work from there.

Order matters: item 1 unblocks most of the rest.

## 1. Restore shell access on the new server (blocks 2, 3, 6)

- [ ] Done

**Why.** The host moved oddspro.ke to a new server (23.106.59.129) in early October.
SSH login works with our key, but every command exits 1 with no output and SFTP closes
at once. That is the cPanel "noshell" state a migration usually leaves behind. Until it
is fixed, nothing can be read on or deployed to the server.

**Steps.**

1. cPanel, Security, then "SSH Access" or "Manage Shell". Set the account to Normal
   Shell (Jailed Shell also works for our scripts).
2. If neither option exists, ask host support: "Please enable shell access for account
   oddsprok after the server migration. SSH key login succeeds, but the session closes
   with no shell."
3. Optional extra check: ask support to confirm the new server's ED25519 host key is
   `SHA256:nPWvbkNyoWDhtdr4Yv45d5DC3CG+m40DyFB8jAwipT4`. Claude already trusted it
   after independent checks. The old keys are backed up in
   `~/.ssh/known_hosts.bak-20261010_150851`.

**Check.** This prints `SHELL_OK` and a shell path:

```bash
ssh oddspro 'echo SHELL_OK; echo $SHELL'
```

## 2. Check the crontab survived the move (after 1)

- [ ] Done

**Why.** The home folder changed from `/home2/oddsprok` to `/home/oddsprok`. Any cron
line with the old path now fails silently. That includes the keep-alive, the collection
watchdog and the daily health snapshot.

**Steps.** Tell Claude "shell is back". Claude reads the crontab, fixes the paths
through a file (never the pipe form, which once wiped the crontab), reinstalls the
health job and verifies it. To look first yourself:

```bash
ssh oddspro 'crontab -l'
```

## 3. Restore the deploy credentials file (before any deploy)

- [ ] Done

**Why.** The x-nomad migration removed `.env.deploy`, `.env.server` and the real `.env`
from this machine. A placeholder dev `.env` now exists so the tests run. It holds no
real secrets and cannot deploy.

**Steps.** Restore `.env.deploy` from your own backup into `D:\Apps\lab\oddspro\`. It
needs `DEPLOY_SSH=oddspro`, `DEPLOY_DB_USER` and `DEPLOY_DB_PASSWORD` (template:
`.env.deploy.example`). Do not paste secrets into chat.

**Check.** The file exists and `DEPLOY_SSH` reads `oddspro`.

## 4. Confirm the API-Football plan was renewed

- [ ] Done

**Why.** The Mega plan end date on record was 2026-10-05. Results kept arriving after
that date, which suggests it was renewed, but nobody has read the dashboard.

**Steps.** dashboard.api-football.com, Subscription. Note the new end date.

**Check.** The plan is active with an end date in the future. Tell Claude the date so
the monitor's `api_plan_soon` warning uses it.

## 5. Deploy the reviewed release (after 1 and 3, when Claude says it is merged)

- [ ] Done

**Why.** Four changes are in progress: the calmer degraded-notice detector, the
in-app health ledger endpoint, batched hotfixes, and odds
history with on-time snapshots plus the due-queue scheduler. They reach production only
through a deploy, and deploys are yours.

**Steps.** Claude merges to `main` and tells you the version. Then follow
`docs/DEPLOYMENT.md` (the "v1.4.0 build 2 routine" section), or say "deploy" and
Claude runs `scripts/deploy-remote.js` for you. New database migrations run
automatically on boot.

Two cautions for this deploy:

- Deploy the app first. Only then update the host copy of `~/ops/prod-health.mjs`,
  because it now imports the app's shared health rules. Against an older app build it
  writes a RED `rules_module_missing` line.
- While both the host cron and the new in-app snapshot run, a RED day sends two SMS.
  Either drop the cron line (the app snapshot replaces it) or switch off
  `HEALTH_SNAPSHOT_SMS` in Admin, Settings.

**Check.** The site answers 200, Admin, About shows the new version, and Claude's
post-deploy probe passes.

## 6. Give the weekly digest an admin token (after 5)

- [ ] Done

**Why.** The new endpoint lets the weekly digest read the health ledger over HTTPS, so
monitoring no longer depends on SSH. The digest needs a token to call it.

**Steps.** Claude will name the exact header and the place to store the token
locally. You supply the value yourself, never in chat.

**Check.** The next digest shows real ledger lines instead of UNREADABLE.

## 7. Hygiene, no deadline

- [ ] Rotate the GitHub personal access token embedded in the `origin` remote URL
      (`git remote -v`). Old leak, still worth rotating.
- [ ] Keep the Claude desktop app running. The weekly digest task
      (`oddspro-weekly-health-digest`) runs only while it is open, and a closed app
      shifts the run to the next launch.
