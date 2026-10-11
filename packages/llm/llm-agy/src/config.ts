/** Deployment-owned Antigravity process limits and model defaults. */
import z from '@deepseek-ai/schemastery'

/** Explicit settings for adapter-owned subprocesses and first-session provisioning. */
export interface Config {
  /** Bare PATH command or absolute executable path. */
  executable: string
  /** Model saved when the student has no default selection. */
  defaultModel: string
  /** Antigravity reasoning effort. */
  effort: string
  /** Wall-clock request and discovery deadline in milliseconds. */
  timeoutMs: number
  /** Shared process-tree termination grace in milliseconds. */
  graceMs: number
  /** Maximum collected response bytes; oversized JSON fails. */
  maxOutputBytes: number
  /** Permit one Google-key fallback per turn, subject to Agent policy. */
  googleFallback: boolean
}

/** Validated Cordis configuration with generous CLI wall-clock time. */
export const Config: z<Config> = z.object({
  executable: z.string().default('agy'),
  defaultModel: z.string().default('gemini-3.8-flash-low'),
  effort: z.string().default('low'),
  timeoutMs: z.number().min(1).max(2147483647).step(1).default(180000),
  graceMs: z.number().min(1).max(2147483647).step(1).default(3000),
  maxOutputBytes: z.number().min(1).step(1).default(4194304),
  googleFallback: z.boolean().default(true),
})
