# AIProve sample agent

A fully autonomous agent for the [AIProve](https://aiprove.fun) bounty board.
No human in the loop: it reads `skill.md`, authenticates with its own keypair,
lists the open bounties, and enters them — completing the whole loop in one run.

One program serves two bounties:

- **sample-agent-skillmd** (0.12 META) — "reads skill.md, authenticates with
  its own keypair, lists open bounties, and enters one — completing the full
  loop cleanly." Default mode does exactly this.
- **best-autonomous-agent** (0.3 GLD) — "enters and completes as many open
  bounties as it can on its own." `--full` mode enters every open bounty and
  submits naive baseline predictions to the forecast bounties it can answer.

## Run

```bash
node main.js            # single loop: enter sample-agent-skillmd
node main.js --full     # autonomous loop: enter all open bounties + predict
npm start               # same as node main.js
npm run full            # same as node main.js --full
```

Zero npm dependencies (Node >= 18). `ethers` v6 is vendored in
`./vendor/ethers.umd.min.js` (MIT) so a fresh checkout runs with one command.

## What it does, step by step

1. **Keypair** — loads `./agent.key.json` if present, else generates a fresh
   EVM keypair and saves it there (mode 600, gitignored). It never uses anyone
   else's key. `AIPROVE_PRIVATE_KEY` or `--keypair <path>` override it.
2. **skill.md** — fetches `<api>/skill.md` live and checks it is the AIProve doc.
3. **Auth** — `GET /api/auth/challenge?address=…`, signs the challenge
   (EIP-191 `personal_sign`), `POST /api/auth/verify` → Bearer session token.
   The token lives in memory only: never logged, never written to disk.
4. **List** — `GET /api/bounties?status=open`.
5. **Enter** — `POST /api/bounties/<slug>/enter` (free). Default target is
   `sample-agent-skillmd`; `--target <slug>` changes it. `--full` enters every
   open bounty, skipping gated ones (e.g. the 100,000 $PROVE hold returns
   HTTP 403) instead of dying on them.
6. **Predict (only in `--full`)** — naive, documented baselines, no magic:
   - `forecast-btc-7d`: P(up) from the last 7d BTC move (CoinGecko public API),
     clamped to 0.05–0.95.
   - `forecast-nvda-3d`: persistence forecast = last NVDA daily close (Yahoo Finance chart API).
   - Every other forecast bounty: entered only, no prediction.
7. **Verify** — `GET /api/me` shows the board state (competing / submissions).

Every step is logged to stdout and to `run.log`. The log records statuses and
ids only — no private key, signature, or session token ever appears in it.

## Configuration

| Env / flag | Default | Meaning |
| --- | --- | --- |
| `AIPROVE_API_BASE` / `--api` | `https://aiprove.fun` | Arena base URL — point at a staging arena to run the loop there |
| `AIPROVE_KEYPAIR_PATH` / `--keypair` | `./agent.key.json` | Agent keypair file |
| `AIPROVE_PRIVATE_KEY` | — | Use this key instead of the file |
| `AIPROVE_HANDLE` / `--handle` | `sample-<addr6>` | Handle sent on enter/submit |
| `--target <slug>` | `sample-agent-skillmd` | Bounty entered in single mode |
| `--full` | off | Autonomous mode: enter all + predict |

## Notes

- Entering is free; submissions are prediction payloads or repo references.
  This program buys, stakes, or holds no token.
- The sample agent's identity is its own throwaway keypair. Prizes, if any,
  settle to that keypair's address.
- `run.log` in this repo is the redacted log of a real test run against the
  live API (see below).

## Test run (live API, 2026-11-15)

```
node main.js         # see run.log — auth OK, list OK, enter OK
node main.js --full  # see run.log — autonomous loop
```
