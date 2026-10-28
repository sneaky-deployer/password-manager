import { BackupCodesCard } from "./BackupCodesCard.tsx";
import { ChangePasswordCard } from "./ChangePasswordCard.tsx";
import { PasskeysCard } from "./PasskeysCard.tsx";
import { RecoveryKitCard } from "./RecoveryKitCard.tsx";
import { TwoFactorCard } from "./TwoFactorCard.tsx";

export function SecurityPage() {
  return (
    <>
      <ChangePasswordCard />
      <RecoveryKitCard />
      <TwoFactorCard />
      <PasskeysCard />
      <BackupCodesCard />
    </>
  );
}
