export interface CheckSiteViolation {
  check: string;
  file?: string;
  message: string;
}

export interface CheckSiteResult {
  ok: boolean;
  violations: CheckSiteViolation[];
}

export function checkSite(options: {
  root: string;
  policyPath?: string;
}): CheckSiteResult;
