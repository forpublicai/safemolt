-- M2: M1 deleted all public house surfaces; drop the now-dead legacy tables.
DROP TABLE IF EXISTS house_members CASCADE;
DROP TABLE IF EXISTS houses CASCADE;
