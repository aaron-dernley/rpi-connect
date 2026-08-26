/**
 * Raspberry Pi Connect (remote access) status: signed-in state, remote
 * shell availability, screen sharing availability. Zero-privilege — runs
 * as the invoking user, not root; `rpi-connect` is a per-user service.
 * Read-only: this model never runs `rpi-connect on/off/signin/signout`.
 *
 * `rpi-connect status` has no `--json`/machine-readable flag (confirmed via
 * `rpi-connect status --help` on this install, rpi-connect 2.12.2), so this
 * parses its human-formatted text output — the roadmap's own fallback for
 * exactly this situation. The signed-out output is fully verified against
 * this Pi (`Signed in: no` / a sign-in hint line); the signed-in output,
 * which presumably adds remote-shell and screen-sharing lines, could not
 * be observed without actually signing in to a Raspberry Pi Connect
 * account — out of scope for an automated build. `remoteShellEnabled`/
 * `screenSharingEnabled` therefore parse defensively: a recognized line is
 * reported, anything else (including the common signed-out case, where
 * those lines don't appear at all) degrades to `null` rather than a
 * guessed value. `rawStatus` is stored verbatim specifically so a human
 * can see what's really being reported once signed in, and so this
 * parser's assumptions can be checked and tightened later.
 *
 * @module
 */
import { z } from "npm:zod@4";

/** Minimal logger shape methods depend on — matches `context.logger`. */
export interface MinimalLogger {
  /** Log a user-visible progress or state-transition message. */
  info(msg: string, props?: Record<string, unknown>): void;
  /** Log a recoverable issue or degraded-behavior message. */
  warn(msg: string, props?: Record<string, unknown>): void;
}

/**
 * Read a text file via `cat` rather than `Deno.readTextFile`. Deno's
 * permission checker demands the literal `--allow-all` flag for `/proc`
 * reads — no scoped `--allow-read` satisfies it, even though the file is
 * world-readable either way. Same workaround the rest of this family uses.
 */
async function catFile(path: string): Promise<string> {
  const cmd = new Deno.Command("cat", {
    args: [path],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  if (!output.success) {
    throw new Error(
      `cat ${path} failed: ${new TextDecoder().decode(output.stderr).trim()}`,
    );
  }
  return new TextDecoder().decode(output.stdout).trim();
}

/** Result of the hardware guard every method runs before doing real work. */
export interface PiHardwareInfo {
  /** `/proc/device-tree/model`, NUL byte stripped. */
  model: string;
}

/** Hardware guard every method calls before writing any resource. Refuses to run on non-Pi hardware. */
export async function assertRaspberryPiHardware(): Promise<PiHardwareInfo> {
  let rawModel: string;
  try {
    rawModel = await catFile("/proc/device-tree/model");
  } catch (error) {
    throw new Error(
      `This model requires Raspberry Pi hardware: /proc/device-tree/model ` +
        `is missing or unreadable (${
          error instanceof Error ? error.message : String(error)
        }).`,
    );
  }
  // The kernel reports this value NUL-terminated, not newline-terminated.
  const model = rawModel.replace(/\0+$/, "").trim();
  if (!model.includes("Raspberry Pi")) {
    throw new Error(
      `This model requires Raspberry Pi hardware: /proc/device-tree/model ` +
        `reports "${model}", which does not contain "Raspberry Pi".`,
    );
  }
  return { model };
}

/** Map a captured boolean-ish word to true/false, or null if unrecognized. */
function wordToBool(word: string): boolean | null {
  const normalized = word.trim().toLowerCase();
  if (["yes", "on", "enabled", "true"].includes(normalized)) return true;
  if (["no", "off", "disabled", "false"].includes(normalized)) return false;
  return null;
}

/** Scan `text` line by line for the first line matching `labelPattern`, returning its captured boolean-ish word mapped to true/false, or null if no line matches. */
function findLabeledBoolean(
  text: string,
  labelPattern: RegExp,
): boolean | null {
  for (const line of text.split("\n")) {
    const match = labelPattern.exec(line);
    if (match) return wordToBool(match[1]);
  }
  return null;
}

/** Parsed `rpi-connect status` output. */
export interface ConnectStatus {
  signedIn: boolean | null;
  remoteShellEnabled: boolean | null;
  screenSharingEnabled: boolean | null;
}

/**
 * Parse `rpi-connect status` output. Only `signedIn` is verified against
 * real output on this Pi (signed-out case); the other two fields parse
 * defensively against label patterns inferred from the roadmap's
 * description and degrade to null — including in the signed-out case,
 * where they genuinely don't appear — rather than guessing.
 */
export function parseConnectStatus(
  text: string,
  logger?: MinimalLogger,
): ConnectStatus {
  const signedIn = findLabeledBoolean(text, /^Signed in:\s*(\S+)/i);
  if (signedIn === null) {
    logger?.warn(
      'No parseable "Signed in:" line in rpi-connect status output; leaving signedIn null',
    );
  }
  const remoteShellEnabled = findLabeledBoolean(
    text,
    /shell\S*\s*(?:access)?:\s*(\S+)/i,
  );
  const screenSharingEnabled = findLabeledBoolean(
    text,
    /screen[\s-]?shar\w*:\s*(\S+)/i,
  );
  return { signedIn, remoteShellEnabled, screenSharingEnabled };
}

const GlobalArgsSchema = z.object({
  rpiConnectPath: z.string().default("rpi-connect").describe(
    "Path to the rpi-connect binary. Override for odd installs.",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const ConnectSchema = z.object({
  signedIn: z.boolean().nullable().describe(
    'Parsed from the "Signed in: yes/no" line. Null if that line is ' +
      "missing or unparseable — e.g. an rpi-connect version with a " +
      "different output format.",
  ),
  remoteShellEnabled: z.boolean().nullable().describe(
    "Whether remote shell access is enabled. Null when rpi-connect status " +
      "doesn't report it at all — notably including the common signed-out " +
      "case on this hardware, where the output has no such line. See " +
      "rawStatus for the actual text if this matters.",
  ),
  screenSharingEnabled: z.boolean().nullable().describe(
    "Whether screen sharing is enabled. Null under the same condition as " +
      "remoteShellEnabled.",
  ),
  rawStatus: z.string().describe(
    "Verbatim `rpi-connect status` output. Stored because the signed-in " +
      "output format could not be verified while building this model — " +
      "see rawStatus to check what's actually being reported.",
  ),
  capturedAt: z.string().describe(
    "ISO-8601 timestamp when this snapshot was captured.",
  ),
});

/** Model definition for `@aaronge/rpi-connect` — Raspberry Pi Connect status. */
export const model = {
  type: "@aaronge/rpi-connect",
  version: "2026.08.26.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    connect: {
      description:
        "Raspberry Pi Connect signed-in state, remote shell availability, " +
        "and screen sharing availability, parsed from rpi-connect status.",
      schema: ConnectSchema,
      lifetime: "infinite" as const,
      garbageCollection: 200,
    },
  },
  methods: {
    readConnect: {
      description:
        "Run rpi-connect status, parse it, and write the connect resource.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: GlobalArgs;
          logger: MinimalLogger;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        await assertRaspberryPiHardware();
        const capturedAt = new Date().toISOString();
        const rpiConnectPath = context.globalArgs.rpiConnectPath;

        context.logger.info("Reading status via {rpiConnectPath} status", {
          rpiConnectPath,
        });
        let rawStatus: string;
        try {
          const cmd = new Deno.Command(rpiConnectPath, {
            args: ["status"],
            stdout: "piped",
            stderr: "piped",
          });
          const output = await cmd.output();
          rawStatus = new TextDecoder().decode(output.stdout);
          if (!output.success && rawStatus.trim().length === 0) {
            throw new Error(
              `rpi-connect status failed: ${
                new TextDecoder().decode(output.stderr).trim()
              }`,
            );
          }
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) {
            throw new Error(
              `rpi-connect not found on PATH (looked for "${rpiConnectPath}"). ` +
                `Set the rpiConnectPath global argument if it lives somewhere nonstandard.`,
            );
          }
          throw error;
        }

        const { signedIn, remoteShellEnabled, screenSharingEnabled } =
          parseConnectStatus(rawStatus, context.logger);

        context.logger.info(
          "Captured connect status: signedIn={signedIn} remoteShellEnabled={remoteShellEnabled} screenSharingEnabled={screenSharingEnabled}",
          { signedIn, remoteShellEnabled, screenSharingEnabled },
        );

        const handle = await context.writeResource("connect", "connect", {
          signedIn,
          remoteShellEnabled,
          screenSharingEnabled,
          rawStatus,
          capturedAt,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
