// Throwaway credentials for the isolated e2e server. They pass the app's password policy
// (12+ characters, zxcvbn score >= 3) and are not used anywhere else.
export const ADMIN = {
  email: "admin@e2e.test",
  password: "Orbit-Lantern-Velvet-7392",
};
export const BOB = {
  email: "bob@e2e.test",
  password: "Marble-Harbor-Falcon-4815",
};
// Journey 4 ends by recovering Bob's account with a new password.
export const BOB_RECOVERED_PASSWORD = "Pewter-Gazelle-Lagoon-5173";
