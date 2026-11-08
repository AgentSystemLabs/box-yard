// Schemas shared by identity API writes and Settings preflight. Never attach input values to an error.
import { z } from "zod"
import { RUNNERS } from "./runner.js"
import { COORDINATOR_SEES, GITHUB_OWNER_RE, GPG_KEY_ID_RE, IDENTITY_CLAUDE_KINDS, IDENTITY_COLORS } from "./identities.js"
import { credentialValue } from "./credentialValidation.js"

export interface ValidationField { path: string; message: string }

export const identityOwner = z.string().trim().regex(GITHUB_OWNER_RE, "A GitHub owner is a user or org name like acme-corp")
const author = z.object({ name: z.string().trim().min(1).max(200), email: z.string().trim().email("That isn't an email address").max(320) })

/** POST /api/identities and create_identity. */
export const identityCreate = z
  .object({
    name: z.string().trim().min(1).max(60),
    color: z.enum(IDENTITY_COLORS).optional(),
    owners: z.array(identityOwner).max(50).optional(),
    author: author.nullable().optional(),
    runners: z.array(z.enum(RUNNERS)).min(1, "Pick at least one runner, or null for every runner").nullable().optional(),
    coordinatorSees: z.enum(COORDINATOR_SEES).optional(),
  })
  .strict()

/** PATCH /api/identities/:id and update_identity. The Default identity keeps its name. */
export const identityPatch = identityCreate.partial().strict()

/** A token's owner is stored lower-case, as GitHub matches owners: "" is every owner the identity serves. */
export const tokenInput = z.object({ owner: z.union([identityOwner, z.literal("")]).default("").transform((o) => o.toLowerCase()), token: credentialValue }).strict()
export const claudeInput = z.object({ kind: z.enum(IDENTITY_CLAUDE_KINDS), value: credentialValue }).strict()
/** PUT /api/identities/:id/signing (shared IdentitySigningInput). */
export const signingInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("gpg"), keyId: z.string().trim().regex(GPG_KEY_ID_RE, "Use a GPG key id or fingerprint"), requireSigned: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal("file"), privateKey: z.string().min(64, "That's too short to be a private key").max(16_000, "That's too long to be an SSH private key"), requireSigned: z.boolean().optional() }).strict(),
  z
    .object({
      kind: z.literal("agent"),
      publicKey: z.string().trim().min(16).max(4000),
      program: z.string().trim().min(1).max(1000).nullable().optional(),
      requireSigned: z.boolean().optional(),
    })
    .strict(),
])
export const signingPatch = z.object({ requireSigned: z.boolean() }).strict()

