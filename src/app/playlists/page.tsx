import type { Metadata } from "next";

import { ModulePlaceholder } from "@/components/module-placeholder";
import { MODULES } from "@/lib/navigation";

export const metadata: Metadata = { title: MODULES.playlists.label };

export default function PlaylistsPage() {
  return <ModulePlaceholder item={MODULES.playlists} />;
}
