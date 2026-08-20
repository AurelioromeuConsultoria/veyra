-- FENCING TOKEN do lease: identifica quem detém o claim atual, para que um
-- worker que perdeu o lease por expiração não conclua um evento que outro
-- worker já assumiu. Nullable: eventos fora de `processing` não têm dono.
ALTER TABLE "OutboxEvent" ADD COLUMN "claimToken" UUID;
