import type { Metadata } from "next";

import { ModulePlaceholder } from "@/components/module-placeholder";
import { MODULES } from "@/lib/navigation";

export const metadata: Metadata = { title: MODULES.analytics.label };

export default function AnalyticsPage() {
  return <ModulePlaceholder item={MODULES.analytics} />;
}
