import { describe, expect, it } from "vitest";

import {
  applyPublishOrder,
  buildCaptionsFromDialogue,
  buildYouTubeMetadata,
  chunkLine,
  DEFAULT_VIDEO_SETTINGS,
  findMetadataConcerns,
  formatCaptionLines,
  isOverdue,
  metricState,
  normalizeHashtags,
  parseCaptionLines,
  parseMetricsForm,
  parseShortMetadataForm,
  renderKey,
  toSrt,
  validateCaptions,
} from "./shorts";

const dialogue = [
  { character: "Papa", line: "Look at this paper." },
  { character: "Mila", line: "A rectangle!" },
];

describe("captions", () => {
  it("splits long lines on word boundaries", () => {
    const chunks = chunkLine("one two three four five six seven eight nine ten eleven twelve", 20);
    expect(chunks.every((c) => c.length <= 20)).toBe(true);
    expect(chunks.join(" ")).toBe("one two three four five six seven eight nine ten eleven twelve");
  });

  it("spreads dialogue over the clip in order without overlaps", () => {
    const cues = buildCaptionsFromDialogue(dialogue, 10);
    expect(cues.map((c) => c.text)).toEqual(["Look at this paper.", "A rectangle!"]);
    expect(cues[0].start).toBeGreaterThan(0);
    expect(cues[1].start).toBeGreaterThanOrEqual(cues[0].end);
    expect(cues.at(-1)!.end).toBeLessThanOrEqual(10);
    expect(validateCaptions(cues, 10).filter((i) => i.level === "fail")).toEqual([]);
  });

  it("returns no captions without dialogue or duration", () => {
    expect(buildCaptionsFromDialogue([], 10)).toEqual([]);
    expect(buildCaptionsFromDialogue(dialogue, 0.5)).toEqual([]);
  });

  it("round-trips the editor format", () => {
    const cues = [
      { start: 0.5, end: 2, text: "Hello" },
      { start: 2.2, end: 4.75, text: "Step one | fold" },
    ];
    const parsed = parseCaptionLines(formatCaptionLines(cues));
    expect(parsed.errors).toEqual([]);
    expect(parsed.cues).toEqual([cues[0], { start: 2.2, end: 4.8, text: "Step one | fold" }]);
  });

  it("accepts m:ss times and reports bad lines", () => {
    const { cues, errors } = parseCaptionLines("0:01.5-0:03 | Hi\nnot a cue\n5-4 | backwards");
    expect(cues).toEqual([{ start: 1.5, end: 3, text: "Hi" }]);
    expect(errors).toHaveLength(2);
  });

  it("flags overlaps, overruns and fast captions", () => {
    const issues = validateCaptions(
      [
        { start: 0, end: 2, text: "a" },
        { start: 1.5, end: 3, text: "This caption has far too many characters for its time" },
        { start: 9, end: 11, text: "late" },
      ],
      10,
    );
    expect(issues.map((i) => i.level)).toEqual(["fail", "warn", "fail"]);
  });

  it("writes SubRip", () => {
    expect(toSrt([{ start: 1.25, end: 62.5, text: "Hi" }])).toBe("1\n00:00:01,250 --> 00:01:02,500\nHi\n");
  });
});

describe("metadata", () => {
  it("normalises hashtags", () => {
    expect(normalizeHashtags("#Shapes, kids  #shapes learning-fun ##Rocket")).toEqual(["#Shapes", "#kids", "#learningfun", "#Rocket"]);
  });

  it("parses the form, including an empty publish order", () => {
    const form = new FormData();
    form.set("title", "  Can Mila make a rocket?  ");
    form.set("hashtags", "shapes kids");
    form.set("hookSeconds", "2.5");
    form.set("publishOrder", "");
    const parsed = parseShortMetadataForm(form);
    expect(parsed.success && parsed.data).toMatchObject({
      title: "Can Mila make a rocket?",
      hashtags: ["#shapes", "#kids"],
      publishOrder: null,
      hookSeconds: 2.5,
    });
  });

  it("rejects titles over YouTube's limit", () => {
    const form = new FormData();
    form.set("title", "x".repeat(101));
    form.set("hookSeconds", "2");
    expect(parseShortMetadataForm(form).success).toBe(false);
  });

  it("flags calls to action and franchise names", () => {
    expect(findMetadataConcerns({ title: "Subscribe for more!", description: "", hashtags: [], hook: "" })).toHaveLength(1);
    expect(findMetadataConcerns({ title: "Rocket fun", description: "", hashtags: ["#PawPatrol", "#paw", "#patrol"], hook: "" })).toEqual([]);
    expect(findMetadataConcerns({ title: "Rocket fun", description: "Like Peppa Pig", hashtags: [], hook: "" })).toHaveLength(1);
    expect(findMetadataConcerns({ title: "Mila's paper rocket", description: "Children count shapes.", hashtags: ["#shapes"], hook: "Ready?" })).toEqual([]);
  });

  it("builds a YouTube upload body", () => {
    const future = new Date(Date.now() + 86_400_000);
    const yt = buildYouTubeMetadata({
      title: "Mila's rocket",
      description: "Mila folds a rocket.",
      hashtags: ["#shapes", "#kids"],
      playlist: "Mila's Paper Rocket",
      language: "English",
      madeForKids: true,
      containsSyntheticMedia: true,
      scheduledAt: future,
      hasCaptions: true,
    });
    expect(yt.snippet).toMatchObject({
      title: "Mila's rocket",
      description: "Mila folds a rocket.\n\n#shapes #kids",
      tags: ["shapes", "kids"],
      defaultLanguage: "en",
    });
    expect(yt.status).toMatchObject({
      privacyStatus: "private",
      publishAt: future.toISOString(),
      selfDeclaredMadeForKids: true,
      containsSyntheticMedia: true,
    });
    expect(yt.extras.captionsFile).toBe("captions.srt");
  });

  it("leaves out past schedule times and unknown languages, and caps tags at 500 characters", () => {
    const yt = buildYouTubeMetadata({
      title: "t",
      description: "",
      hashtags: Array.from({ length: 60 }, (_, i) => `#tag${String(i).padStart(10, "x")}`),
      playlist: "",
      language: "Klingon",
      madeForKids: true,
      containsSyntheticMedia: true,
      scheduledAt: new Date(Date.now() - 1000),
      hasCaptions: false,
    });
    expect(yt.status).not.toHaveProperty("publishAt");
    expect(yt.snippet).not.toHaveProperty("defaultLanguage");
    expect(yt.snippet.tags.join(",").length).toBeLessThanOrEqual(500);
  });
});

describe("publishing order", () => {
  it("maps Claude's numbers onto ids and keeps every Short", () => {
    const ordered = applyPublishOrder(["a", "b", "c", "d"], {
      order: [
        { shortNumber: 3, reason: "best opener" },
        { shortNumber: 3, reason: "duplicate" },
        { shortNumber: 9, reason: "unknown" },
        { shortNumber: 1, reason: "story start" },
      ],
      note: "",
    });
    expect(ordered.map((o) => [o.id, o.position])).toEqual([
      ["c", 1],
      ["a", 2],
      ["b", 3],
      ["d", 4],
    ]);
    expect(ordered[0].reason).toBe("best opener");
  });

  it("knows when a schedule has passed", () => {
    const past = new Date(1000);
    expect(isOverdue("scheduled", past, 2000)).toBe(true);
    expect(isOverdue("published", past, 2000)).toBe(false);
    expect(isOverdue("scheduled", null, 2000)).toBe(false);
  });
});

describe("render key", () => {
  const base = { sourceFilePath: "scenes/a.mp4", settings: DEFAULT_VIDEO_SETTINGS, captions: [{ start: 0, end: 1, text: "Hi" }], hook: "Ready?", hookSeconds: 2.5 };

  it("changes when anything visible in the render changes", () => {
    expect(renderKey(base)).toBe(renderKey({ ...base }));
    expect(renderKey(base)).not.toBe(renderKey({ ...base, hook: "Go!" }));
    expect(renderKey(base)).not.toBe(renderKey({ ...base, settings: { ...DEFAULT_VIDEO_SETTINGS, zoom: 1.5 } }));
  });

  it("ignores captions and hook when they aren't burned in", () => {
    const off = { ...DEFAULT_VIDEO_SETTINGS, burnCaptions: false, showHook: false };
    expect(renderKey({ ...base, settings: off })).toBe(renderKey({ ...base, settings: off, captions: [], hook: "other" }));
  });
});

describe("analytics", () => {
  it("parses optional numbers and keeps empty fields as null", () => {
    const form = new FormData();
    form.set("capturedAt", "2026-11-02");
    form.set("views", "1,234");
    form.set("viewedPercent", "71.5");
    form.set("likes", "");
    form.set("traffic_shorts_feed", "88");
    const parsed = parseMetricsForm(form);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toMatchObject({ views: 1234, viewedPercent: 71.5, likes: null, subscribersGained: null, trafficSources: { shorts_feed: 88 } });
  });

  it("rejects negative or fractional counts", () => {
    const form = new FormData();
    form.set("capturedAt", "2026-11-02");
    form.set("views", "1.5");
    expect(parseMetricsForm(form).success).toBe(false);
    form.set("views", "-3");
    expect(parseMetricsForm(form).success).toBe(false);
  });

  it("explains empty metrics instead of showing zero", () => {
    expect(metricState(false, null)).toBe("not_published");
    expect(metricState(true, null)).toBe("not_entered");
    expect(metricState(true, "0")).toBe("value");
  });
});
