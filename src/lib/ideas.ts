import { z } from "zod";

// Shared by the DB schema (pg enums), server validation and client forms.
export const IDEA_STATUSES = [
  "draft",
  "approved",
  "scripted",
  "generated",
  "published",
  "archived",
] as const;
export const AGE_GROUPS = ["0-2", "3-5", "6-8", "9-12"] as const;
export const VIDEO_FORMATS = ["short", "standard", "long"] as const;
export const PRIORITIES = ["low", "medium", "high"] as const;
export const CATEGORIES = [
  "songs",
  "stories",
  "learning",
  "animals",
  "adventure",
  "bedtime",
  "seasonal",
  "other",
] as const;
// Every idea is checked for originality (no copying of existing shows, characters or songs)
// before it moves into story writing.
export const ORIGINALITY_STATUSES = ["not_reviewed", "in_review", "original", "needs_changes"] as const;

export type IdeaStatus = (typeof IDEA_STATUSES)[number];
export type Category = (typeof CATEGORIES)[number];
export type OriginalityStatus = (typeof ORIGINALITY_STATUSES)[number];

export const STATUS_LABELS: Record<IdeaStatus, string> = {
  draft: "Draft",
  approved: "Approved",
  scripted: "Scripted",
  generated: "Generated",
  published: "Published",
  archived: "Archived",
};

export const AGE_GROUP_LABELS: Record<(typeof AGE_GROUPS)[number], string> = {
  "0-2": "Babies (0–2)",
  "3-5": "Preschool (3–5)",
  "6-8": "Early school (6–8)",
  "9-12": "Older kids (9–12)",
};

export const FORMAT_LABELS: Record<(typeof VIDEO_FORMATS)[number], string> = {
  short: "Short (< 60s)",
  standard: "Standard (2–8 min)",
  long: "Long / compilation",
};

export const PRIORITY_LABELS: Record<(typeof PRIORITIES)[number], string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

export const CATEGORY_LABELS: Record<Category, string> = {
  songs: "Songs & rhymes",
  stories: "Stories",
  learning: "Learning",
  animals: "Animals & nature",
  adventure: "Adventure",
  bedtime: "Bedtime",
  seasonal: "Seasonal",
  other: "Other",
};

export const ORIGINALITY_LABELS: Record<OriginalityStatus, string> = {
  not_reviewed: "Not reviewed",
  in_review: "In review",
  original: "Original",
  needs_changes: "Needs changes",
};

export const ideaInputSchema = z.object({
  title: z.string().trim().min(3, "Title must be at least 3 characters").max(120),
  description: z.string().trim().max(2000).default(""),
  category: z.enum(CATEGORIES),
  sourceUrl: z
    .string()
    .trim()
    .max(2000)
    .default("")
    .refine((s) => s === "" || /^https?:\/\/\S+\.\S+/i.test(s), "Enter a full http(s) URL")
    .transform((s) => s || null),
  status: z.enum(IDEA_STATUSES).default("draft"),
  originalityStatus: z.enum(ORIGINALITY_STATUSES),
  ageGroup: z.enum(AGE_GROUPS),
  format: z.enum(VIDEO_FORMATS),
  priority: z.enum(PRIORITIES),
  tags: z
    .string()
    .default("")
    .transform((s) =>
      [
        ...new Set(
          s
            .split(",")
            .map((t) => t.trim().toLowerCase())
            .filter(Boolean),
        ),
      ].slice(0, 15),
    ),
  notes: z.string().trim().max(5000).default(""),
  madeForKids: z.boolean(),
  containsSyntheticMedia: z.boolean(),
});

export type IdeaFieldErrors = Partial<Record<keyof z.input<typeof ideaInputSchema>, string[]>>;

export type IdeaFormState =
  { ok: true; message: string } | { ok: false; message?: string; errors?: IdeaFieldErrors } | null;

export function parseIdeaForm(formData: FormData) {
  return ideaInputSchema.safeParse({
    title: formData.get("title") ?? "",
    description: formData.get("description") ?? "",
    category: formData.get("category"),
    sourceUrl: formData.get("sourceUrl") ?? "",
    status: formData.get("status") || undefined,
    originalityStatus: formData.get("originalityStatus"),
    ageGroup: formData.get("ageGroup"),
    format: formData.get("format"),
    priority: formData.get("priority"),
    tags: formData.get("tags") ?? "",
    notes: formData.get("notes") ?? "",
    madeForKids: formData.get("madeForKids") === "on",
    containsSyntheticMedia: formData.get("containsSyntheticMedia") === "on",
  });
}

export const ideaFiltersSchema = z.object({
  q: z.string().trim().max(100).optional().catch(undefined),
  status: z.enum(IDEA_STATUSES).optional().catch(undefined),
  category: z.enum(CATEGORIES).optional().catch(undefined),
  ageGroup: z.enum(AGE_GROUPS).optional().catch(undefined),
  priority: z.enum(PRIORITIES).optional().catch(undefined),
  originality: z.enum(ORIGINALITY_STATUSES).optional().catch(undefined),
});

export type IdeaFilters = z.infer<typeof ideaFiltersSchema>;

// Unknown or malformed query params are dropped rather than causing an error page.
export function parseIdeaFilters(params: Record<string, string | string[] | undefined>) {
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;
  return ideaFiltersSchema.parse({
    q: first(params.q),
    status: first(params.status),
    category: first(params.category),
    ageGroup: first(params.ageGroup),
    priority: first(params.priority),
    originality: first(params.originality),
  });
}

// Video metrics are derived from an idea's workflow status until the Production Studio has its
// own records. Stories in progress are counted from the stories table.
export const STAGE_GROUPS = {
  videosInProduction: ["scripted", "generated"],
  published: ["published"],
} as const satisfies Record<string, readonly IdeaStatus[]>;

export function ideasHref(filters: IdeaFilters) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value);
  }
  const query = params.toString();
  return query ? `/ideas?${query}` : "/ideas";
}
