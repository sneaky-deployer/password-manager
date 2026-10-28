import { Card } from "../../components/ui/index.ts";
import { PasswordGeneratorPanel } from "./PasswordGeneratorPanel.tsx";

/** The standalone `/generator` page. */
export function GeneratorPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Generator</h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Passwords are generated in your browser with a cryptographic random source and are never
          sent anywhere.
        </p>
      </div>
      <Card>
        <PasswordGeneratorPanel />
      </Card>
    </div>
  );
}
