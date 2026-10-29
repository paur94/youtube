import type { Metadata } from "next";

import { ModulePlaceholder } from "@/components/module-placeholder";
import { MODULES } from "@/lib/navigation";

export const metadata: Metadata = { title: MODULES.advertising.label };

export default function AdvertisingPage() {
  return <ModulePlaceholder item={MODULES.advertising} />;
}
