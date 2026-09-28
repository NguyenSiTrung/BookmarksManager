export interface AuditViolation {
  check: string;
  file?: string;
  message: string;
}

export interface AuditManifestSummary {
  name: string | null;
  version: string | null;
  permissions: string[];
  optional_host_permissions: string[];
  icons: Record<string, string>;
}

export interface AuditReleaseResult {
  ok: boolean;
  violations: AuditViolation[];
  name: string;
  bytes: number;
  sha256: string | null;
  manifest: AuditManifestSummary | null;
}

export function auditRelease(options: {
  zipPath: string;
  expectedVersion: string;
  permissionsMarkdown?: string;
}): AuditReleaseResult;
