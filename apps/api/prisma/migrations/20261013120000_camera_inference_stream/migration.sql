-- Which stream the engine decodes (spec section 2). SUB falls back to the main URL without a sub URL.
ALTER TABLE "Camera" ADD COLUMN "inferenceStream" "StreamChoice" NOT NULL DEFAULT 'MAIN';
