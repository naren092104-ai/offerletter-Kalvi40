ALTER TABLE public.candidates
ADD COLUMN IF NOT EXISTS phone TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_candidates_phone ON public.candidates (phone);
