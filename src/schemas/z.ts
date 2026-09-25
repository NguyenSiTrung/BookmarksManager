import { z } from "zod";

// MV3 extension pages forbid eval()/new Function(), so every schema in this
// project must run under Zod's jitless (CSP-safe) compiler. This module is the
// single place that configures zod; all other schema modules import `z` from
// here so this side effect is guaranteed to run before any schema is defined.
z.config({ jitless: true });

export { z };
