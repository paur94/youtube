import {
  BarChart3Icon,
  BookOpenIcon,
  ClapperboardIcon,
  LayoutDashboardIcon,
  LightbulbIcon,
  ListVideoIcon,
  type LucideIcon,
  MegaphoneIcon,
  SendIcon,
  SettingsIcon,
  SmileIcon,
} from "lucide-react";

export type Module = {
  href: string;
  label: string;
  icon: LucideIcon;
  description: string;
  /** False for modules that only have a placeholder page so far. */
  ready: boolean;
  /** Shown on the placeholder page of modules that are not built yet. */
  planned?: string[];
};

export const MODULES = {
  dashboard: {
    href: "/",
    label: "Dashboard",
    icon: LayoutDashboardIcon,
    description: "Your production pipeline at a glance",
    ready: true,
  },
  ideas: {
    href: "/ideas",
    label: "Idea Discovery",
    icon: LightbulbIcon,
    description: "Collect, review and prioritise video concepts",
    ready: true,
  },
  stories: {
    href: "/stories",
    label: "Story Workshop",
    icon: BookOpenIcon,
    description: "Turn ideas into age-appropriate scripts with Claude",
    ready: true,
  },
  production: {
    href: "/production",
    label: "Production Studio",
    icon: ClapperboardIcon,
    description: "Turn approved stories into scenes, generate assets with Higgsfield and review them",
    ready: true,
  },
  characters: {
    href: "/characters",
    label: "Characters",
    icon: SmileIcon,
    description: "Keep recurring characters consistent across videos",
    ready: true,
  },
  playlists: {
    href: "/playlists",
    label: "Playlists",
    icon: ListVideoIcon,
    description: "Group videos into series and themed collections",
    ready: false,
    planned: ["Series and season planning", "Ordering and release cadence", "Sync with YouTube playlists"],
  },
  publishing: {
    href: "/publishing",
    label: "Publishing",
    icon: SendIcon,
    description: "Schedule uploads with made-for-kids settings",
    ready: false,
    planned: [
      "Release calendar",
      "Title, description and thumbnail checklist",
      "COPPA and synthetic-media disclosure review",
      "YouTube upload integration (later milestone)",
    ],
  },
  analytics: {
    href: "/analytics",
    label: "Analytics",
    icon: BarChart3Icon,
    description: "Views, watch time and retention per video",
    ready: false,
    planned: ["Per-video and per-series performance", "Retention curves", "Idea-to-performance feedback loop"],
  },
  advertising: {
    href: "/advertising",
    label: "Advertising Budget",
    icon: MegaphoneIcon,
    description: "Plan and track promotion spend",
    ready: false,
    planned: ["Monthly budget and spend tracking", "Campaign log per video", "Cost per subscriber estimates"],
  },
  settings: {
    href: "/settings",
    label: "Settings",
    icon: SettingsIcon,
    description: "Workspace data and configuration",
    ready: true,
  },
} satisfies Record<string, Module>;

export const NAV_GROUPS: { label: string; items: Module[] }[] = [
  { label: "Overview", items: [MODULES.dashboard] },
  {
    label: "Create",
    items: [MODULES.ideas, MODULES.stories, MODULES.production, MODULES.characters],
  },
  { label: "Distribute", items: [MODULES.playlists, MODULES.publishing] },
  { label: "Grow", items: [MODULES.analytics, MODULES.advertising] },
];
