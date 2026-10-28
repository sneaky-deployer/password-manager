import { ZxcvbnFactory } from "@zxcvbn-ts/core";
import { adjacencyGraphs, dictionary } from "@zxcvbn-ts/language-common";

/** PLAN.md 10.1: at least 12 characters and a zxcvbn score of 3 or more. */
export const MIN_PASSWORD_LENGTH = 12;
export const MIN_PASSWORD_SCORE = 3;

const zxcvbn = new ZxcvbnFactory({ dictionary, graphs: adjacencyGraphs });

export interface PasswordAssessment {
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
  longEnough: boolean;
  strongEnough: boolean;
  ok: boolean;
  warning: string;
}

const LABELS = ["Very weak", "Weak", "Fair", "Good", "Strong"] as const;

/**
 * Strength of a candidate master password. `userInputs` (email, name parts) are penalised
 * because attackers try them first. The check runs entirely in the browser.
 */
export function assessPassword(password: string, userInputs: string[] = []): PasswordAssessment {
  if (!password) {
    return { score: 0, label: "", longEnough: false, strongEnough: false, ok: false, warning: "" };
  }
  const result = zxcvbn.check(password.slice(0, 128), userInputs);
  const longEnough = [...password].length >= MIN_PASSWORD_LENGTH;
  const strongEnough = result.score >= MIN_PASSWORD_SCORE;
  return {
    score: result.score,
    label: LABELS[result.score],
    longEnough,
    strongEnough,
    ok: longEnough && strongEnough,
    warning: result.feedback.warning ?? "",
  };
}
