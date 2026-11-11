---
'@weiliang0121/capix-model-exchanges': minor
---

Store immutable initial request data and model-visible tool catalogs alongside their accumulated exchanges. Resources now register ModelExchanges directly and use explicit origin references to reconstruct requests. Snapshot v2 and the discriminated persistence commits replace the old scope-only format; existing hosts must adapt their resource and persistence contracts. Old snapshots are rejected without migration.
