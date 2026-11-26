-- DEP-3: trip tags for the Fill seats audience (past travellers with matching tags). Additive.
ALTER TABLE "Trip" ADD COLUMN "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];
