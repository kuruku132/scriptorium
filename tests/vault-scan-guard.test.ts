import { describe, expect, it } from "vitest";
import { VaultScanGuard } from "../src/app/vault-scan-guard";

describe("VaultScanGuard", () => {
  it("is not suppressed by default", () => {
    const guard = new VaultScanGuard();
    expect(guard.isSuppressed()).toBe(false);
  });

  it("is suppressed during the action and restored after success", async () => {
    const guard = new VaultScanGuard();
    let seen = false;
    await guard.withSuppressed(async () => {
      seen = guard.isSuppressed();
    });
    expect(seen).toBe(true);
    expect(guard.isSuppressed()).toBe(false);
  });

  it("restores the counter after a thrown operation", async () => {
    const guard = new VaultScanGuard();
    await expect(
      guard.withSuppressed(async () => {
        expect(guard.isSuppressed()).toBe(true);
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(guard.isSuppressed()).toBe(false);
  });

  it("stays suppressed across nested calls until the outer call ends", async () => {
    const guard = new VaultScanGuard();
    let innerSeen = false;
    let afterInner = false;
    await guard.withSuppressed(async () => {
      await guard.withSuppressed(async () => {
        innerSeen = guard.isSuppressed();
      });
      afterInner = guard.isSuppressed();
    });
    expect(innerSeen).toBe(true);
    expect(afterInner).toBe(true);
    expect(guard.isSuppressed()).toBe(false);
  });
});