import { z } from "zod";

export const text = (max: number) => z.string().trim().min(1).max(max);
export const optionalText = (max: number) => z.string().trim().max(max).optional().nullable();
export const dogSize = z.enum(["small", "medium", "large", "xl"]);

export const NewDog = z.object({
  name: text(60),
  breed: optionalText(60),
  size: dogSize,
  notes: optionalText(1000),
});

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
