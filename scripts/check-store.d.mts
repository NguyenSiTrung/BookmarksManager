export interface CheckStoreViolation {
  check: string;
  file?: string;
  message: string;
}

export interface CheckStoreResult {
  ok: boolean;
  violations: CheckStoreViolation[];
}

export const RELEASE_URLS: Readonly<{
  homepage: string;
  privacy: string;
  support: string;
}>;

export type CheckStoreChannel = "trusted-tester" | "public";

export function checkStore(options: {
  root: string;
  release: string;
  channel?: CheckStoreChannel;
}): CheckStoreResult;
