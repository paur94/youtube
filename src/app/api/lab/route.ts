import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db";
import { labProjects } from "@/db/schema";
import { LAB_ASPECT_RATIOS, LAB_MAX_REFERENCES, LAB_TOPIC_MAX, type LabReference } from "@/lib/lab";
import { MediaError, saveMedia } from "@/server/media/storage";
import { sameOrigin } from "@/server/same-origin";

// Adult Lab uploads go through a route handler because server actions cap request bodies at 1 MB.
// Without projectId it creates a project from the topic; with one it adds reference images to it.

const DB_ERROR = "Could not reach the database. Is Postgres running (npm run db:up)?";

function json(body: Record<string, unknown>, status = 200) {
  return Response.json(body, { status });
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ ok: false, message: "Cross-origin uploads are not allowed" }, 403);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ ok: false, message: "Could not read the upload" }, 400);
  }
  const files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  const projectId = z.uuid().safeParse(form.get("projectId"));

  let project: typeof labProjects.$inferSelect | undefined;
  try {
    if (projectId.success) {
      [project] = await db.select().from(labProjects).where(eq(labProjects.id, projectId.data));
      if (!project) return json({ ok: false, message: "Project not found" }, 404);
    }
  } catch {
    return json({ ok: false, message: DB_ERROR }, 503);
  }

  const settings = z
    .object({ topic: z.string().trim().min(3, "Describe the topic").max(LAB_TOPIC_MAX), aspectRatio: z.enum(LAB_ASPECT_RATIOS) })
    .safeParse({ topic: form.get("topic"), aspectRatio: form.get("aspectRatio") ?? "9:16" });
  if (!project && !settings.success) return json({ ok: false, message: settings.error.issues[0].message }, 400);

  const existing = project?.references ?? [];
  if (existing.length + files.length > LAB_MAX_REFERENCES) {
    return json({ ok: false, message: `Up to ${LAB_MAX_REFERENCES} reference images per project` }, 400);
  }

  const id = project?.id ?? randomUUID();
  const added: LabReference[] = [];
  for (const file of files) {
    try {
      const saved = await saveMedia(new Uint8Array(await file.arrayBuffer()), file.type, `lab/${id}/references`);
      if (saved.kind !== "image") return json({ ok: false, message: `${file.name} is not an image` }, 400);
      added.push({ id: randomUUID(), filePath: saved.filePath, contentType: saved.contentType, name: file.name.slice(0, 200) });
    } catch (error) {
      return json({ ok: false, message: error instanceof MediaError ? `${file.name}: ${error.message}` : "Could not store a file" }, 400);
    }
  }

  try {
    if (project) {
      await db
        .update(labProjects)
        .set({ references: [...existing, ...added], updatedAt: new Date() })
        .where(eq(labProjects.id, project.id));
    } else {
      await db.insert(labProjects).values({ id, ...settings.data!, references: added });
    }
  } catch {
    return json({ ok: false, message: DB_ERROR }, 503);
  }

  revalidatePath("/adult");
  return json({ ok: true, id, message: project ? `${added.length} reference image(s) added` : "Project created" });
}
