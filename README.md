# @aaronge/rpi-connect

Raspberry Pi Connect (remote access) status — signed-in state, remote shell
availability, screen sharing availability — as a typed, versioned Swamp
model. Once remote access matters, its status should be observable rather
than assumed. Zero privileges: `rpi-connect` runs as the invoking user, not
root, and this model never runs `rpi-connect on/off/signin/signout`.

`rpi-connect status` has no `--json`/machine-readable flag (confirmed via
`rpi-connect status --help` against rpi-connect 2.12.2), so this parses its
human-formatted text output. **Important caveat:** the signed-out output is
fully verified against real hardware (`Signed in: no`); the signed-in
output — which presumably adds remote-shell and screen-sharing lines —
could not be observed without actually signing in to a Raspberry Pi
Connect account, which is out of scope for an automated build. See "How it
works" below for exactly what that means for `remoteShellEnabled`/
`screenSharingEnabled`.

## Installation

```sh
swamp extension pull @aaronge/rpi-connect
```

## Usage

```sh
swamp model create @aaronge/rpi-connect rpi-local

swamp model method run rpi-local readConnect
```

The method writes one resource: `connect`. Every field is described — run
`swamp model type describe @aaronge/rpi-connect` to see the full schema.

Reference the latest snapshot from a workflow assert step or another model:

```yaml
expr: >-
  data.latest("rpi-local", "connect").attributes.signedIn == true
```

## Global arguments

| Arg              | Default          | Notes                                |
| ------------------ | ------------------ | --------------------------------------- |
| `rpiConnectPath`  | `"rpi-connect"`   | Override for odd installs.             |

## How it works

- **`connect`** — `signedIn` is parsed from the `Signed in: yes/no` line
  and is verified against real output on this hardware. `remoteShellEnabled`
  and `screenSharingEnabled` parse defensively against label patterns
  inferred from the roadmap's own description of what `rpi-connect status`
  reports when signed in — they degrade to `null` (not a guessed value)
  whenever no matching line is found, which includes the common signed-out
  case on this hardware, where those lines don't appear at all. `rawStatus`
  stores the command's verbatim output specifically so a human can check
  what's actually being reported and tighten the parser once signed in —
  do that before relying on the two boolean fields in a signed-in context.

Refuses to run on non-Pi hardware — checking `/proc/device-tree/model`
names a Raspberry Pi — before writing anything.

## Workflow

The extension ships an `rpi-connect` workflow: a `collect` job runs
`readConnect`, an `assert` job checks `signedIn == true` with
**`allowFailure: true`** (this machine is currently signed out, a normal
un-opted-in state, not a failure — flip this to `false` once remote access
actually matters to you), and a `report` job prints a one-screen summary
regardless of whether the assert job passed. Scheduled every 5 minutes via
`trigger.schedule`, the same cadence as the other telemetry-focused
extensions in this family.

## License

MIT — see LICENSE for details.
