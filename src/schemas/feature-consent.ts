import { z } from "./z";
import type { LlmProviderRecord } from "./llm";
import { consentVersionForScope } from "../consent/records";
import { resolveLlmDestination } from "../llm/providers";

export const FeatureConsentScope = z.enum(["llm_explain", "llm_restructure"]);
export type FeatureConsentScope = z.infer<typeof FeatureConsentScope>;

/** Closed, content-free binding; neither a grant nor authority to redirect. */
export const FeatureConsentApproval = z.strictObject({
  providerId: z.string().min(1),
  origin: z.url(),
  model: z.string().min(1),
  endpoint: z.url(),
  consentVersion: z.number().int().positive(),
});
export type FeatureConsentApproval = z.infer<typeof FeatureConsentApproval>;

export const FeatureConsentDisclosure = z.strictObject({
  scope: FeatureConsentScope,
  recipient: z.string().min(1),
  approval: FeatureConsentApproval,
});
export type FeatureConsentDisclosure = z.infer<typeof FeatureConsentDisclosure>;

export function featureConsentDisclosure(
  scope: FeatureConsentScope,
  record: LlmProviderRecord,
): FeatureConsentDisclosure {
  const destination = resolveLlmDestination(record.provider);
  return {
    scope,
    recipient: record.provider.kind === "custom"
      ? "Custom LLM provider"
      : record.provider.preset === "openai" ? "OpenAI" : "OpenRouter",
    approval: {
      providerId: record.providerId,
      origin: destination.origin,
      model: destination.model,
      endpoint: destination.chatCompletionsUrl,
      consentVersion: consentVersionForScope(scope),
    },
  };
}

export function matchesFeatureConsentApproval(
  approved: FeatureConsentApproval,
  current: FeatureConsentApproval,
): boolean {
  return approved.providerId === current.providerId &&
    approved.origin === current.origin &&
    approved.model === current.model &&
    approved.endpoint === current.endpoint &&
    approved.consentVersion === current.consentVersion;
}
