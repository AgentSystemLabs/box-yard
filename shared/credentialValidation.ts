import { z } from "zod"

export const credentialValue = z
  .string()
  .trim()
  .min(8, "That looks too short to be a key or token")
  .max(2000, "That's too long to be a key or token")
  .regex(/^[\x21-\x7e]+$/, "Keys and tokens have no spaces or special characters")

