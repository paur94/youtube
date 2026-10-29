import type { Metadata } from "next";

import { ModulePlaceholder } from "@/components/module-placeholder";
import { MODULES } from "@/lib/navigation";

export const metadata: Metadata = { title: MODULES.publishing.label };

export default function PublishingPage() {
  return <ModulePlaceholder item={MODULES.publishing} />;
}
