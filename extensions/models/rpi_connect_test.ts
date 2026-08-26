// Run with `deno test -A`. -A is needed because catFile shells out to `cat`
// for /proc reads — see the sibling extensions' test files for why Deno's
// permission checker requires it even for world-readable files.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  createModelTestContext,
  withMockedCommand,
} from "jsr:@swamp-club/swamp-testing@0.20260824.32";
import {
  assertRaspberryPiHardware,
  model,
  parseConnectStatus,
} from "./rpi_connect.ts";

// createModelTestContext() returns a MethodContext typed with a default
// Record<string, unknown> globalArgs — narrower than each execute()'s own
// inline context type. This cast bridges that gap; the contextual type at
// each call site (inferred from execute()'s own parameter type) fills in T.
function asContext<T>(context: unknown): T {
  return context as T;
}

const DEFAULT_GLOBAL_ARGS = { rpiConnectPath: "rpi-connect" };

// --- parseConnectStatus ------------------------------------------------

// Captured live from `rpi-connect status` on this Pi 5 (rpi-connect
// 2.12.2), signed out.
const REAL_SIGNED_OUT_OUTPUT =
  "Signed in: no\nTo sign in, run rpi-connect signin\n";

Deno.test("parseConnectStatus parses the real signed-out output: signedIn=false, others null", () => {
  const result = parseConnectStatus(REAL_SIGNED_OUT_OUTPUT);
  assertEquals(result.signedIn, false);
  assertEquals(result.remoteShellEnabled, null);
  assertEquals(result.screenSharingEnabled, null);
});

// Inferred shape, NOT observed on real hardware — this install is signed
// out and signing in requires a real Raspberry Pi Connect account, out of
// scope for an automated build. This test documents the parser's
// assumption and should be revisited against real signed-in output.
const INFERRED_SIGNED_IN_OUTPUT =
  "Signed in: yes\nRemote shell access: enabled\nScreen sharing: disabled\n";

Deno.test("parseConnectStatus parses an inferred signed-in output shape", () => {
  const result = parseConnectStatus(INFERRED_SIGNED_IN_OUTPUT);
  assertEquals(result.signedIn, true);
  assertEquals(result.remoteShellEnabled, true);
  assertEquals(result.screenSharingEnabled, false);
});

Deno.test("parseConnectStatus degrades signedIn to null with a warning when the line is missing entirely", () => {
  const warnings: string[] = [];
  const result = parseConnectStatus("Some unexpected future output format\n", {
    info: () => {},
    warn: (m) => warnings.push(m),
  });
  assertEquals(result.signedIn, null);
  assertEquals(warnings.length, 1);
});

Deno.test("parseConnectStatus is case-insensitive and tolerant of extra whitespace", () => {
  const result = parseConnectStatus("signed in:   YES  \n");
  assertEquals(result.signedIn, true);
});

// --- readConnect: real hardware + mocked signed-in/not-found scenarios ---
//
// This model refuses to run at all off Pi hardware, so — like the sibling
// extensions' method-level tests — the primary test exercises the real
// rpi-connect status on whatever host runs the suite.

Deno.test("readConnect writes a connect resource from real rpi-connect status output", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: DEFAULT_GLOBAL_ARGS,
    methodName: "readConnect",
  });

  await model.methods.readConnect.execute({}, asContext(context));

  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "connect");
  const data = written[0].data as {
    signedIn: boolean | null;
    rawStatus: string;
    capturedAt: string;
  };
  assert(data.rawStatus.length > 0);
  assert(typeof data.capturedAt === "string");
  // This install is signed out as of writing this test.
  assertEquals(data.signedIn, false);
});

Deno.test("readConnect surfaces a clean not-found error when rpi-connect is not on PATH", async () => {
  const { context } = createModelTestContext({
    globalArgs: { rpiConnectPath: "/nonexistent/rpi-connect" },
    methodName: "readConnect",
  });

  await assertRejects(
    () => model.methods.readConnect.execute({}, asContext(context)),
    Error,
    "not found on PATH",
  );
});

Deno.test("readConnect parses a mocked signed-in scenario end to end", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: DEFAULT_GLOBAL_ARGS,
    methodName: "readConnect",
  });

  await withMockedCommand((command, args) => {
    if (command === "cat" && args[0] === "/proc/device-tree/model") {
      return { stdout: "Raspberry Pi 5 Model B Rev 1.1\0", code: 0 };
    }
    if (command === "rpi-connect" && args[0] === "status") {
      return { stdout: INFERRED_SIGNED_IN_OUTPUT, code: 0 };
    }
    throw new Error(`unexpected command in test: ${command} ${args.join(" ")}`);
  }, () => model.methods.readConnect.execute({}, asContext(context)));

  const data = getWrittenResources()[0].data as {
    signedIn: boolean | null;
    remoteShellEnabled: boolean | null;
    screenSharingEnabled: boolean | null;
  };
  assertEquals(data.signedIn, true);
  assertEquals(data.remoteShellEnabled, true);
  assertEquals(data.screenSharingEnabled, false);
});

Deno.test("assertRaspberryPiHardware strips the trailing NUL from /proc/device-tree/model on this real Pi 5", async () => {
  const hardware = await assertRaspberryPiHardware();
  assert(!hardware.model.includes("\0"));
  assertEquals(hardware.model, hardware.model.trim());
  assert(hardware.model.includes("Raspberry Pi"));
});
