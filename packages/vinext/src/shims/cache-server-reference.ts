import { registerServerReference } from "@vitejs/plugin-rsc/react/rsc";
import {
  decryptActionBoundArgs,
  encryptActionBoundArgs,
} from "@vitejs/plugin-rsc/utils/encryption-runtime";
import { registerCachedFunction } from "./cache-runtime.js";

export { encryptActionBoundArgs };

export function registerCachedServerReference(
  fn: (...args: unknown[]) => Promise<unknown>,
  cacheId: string,
  cacheVariant: string,
  referenceId: string,
  referenceName: string,
  hasEncryptedBoundArgs: boolean,
): (...args: unknown[]) => Promise<unknown> {
  const cached = registerCachedFunction(fn, cacheId, cacheVariant);
  const callable: (...args: unknown[]) => Promise<unknown> = hasEncryptedBoundArgs
    ? async (encryptedBoundArgs: unknown, ...args: unknown[]) => {
        const boundArgs = (await decryptActionBoundArgs(
          encryptedBoundArgs as Promise<string>,
        )) as unknown[];
        return cached(...boundArgs, ...args);
      }
    : cached;

  return registerServerReference(callable, referenceId, referenceName) as typeof callable;
}
