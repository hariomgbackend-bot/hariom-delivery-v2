import { logger } from "../utils/logger.js";
import { getDb } from "../utils/firestore.js";
import { GbpLocation } from "../types.js";

const log = logger("gbp");

export async function listAccounts(
  _uid: string
): Promise<{ name: string; accountName: string }[]> {
  log.info("GBP API not yet available — waiting for access approval");
  return [];
}

export async function listLocations(
  _uid: string,
  _accountName: string
): Promise<GbpLocation[]> {
  log.info("GBP API not yet available — waiting for access approval");
  return [];
}

export async function syncLocationsToFirestore(
  _uid: string,
  _accountName: string
): Promise<number> {
  log.info("GBP sync not available — waiting for access approval");
  return 0;
}

export async function getLocationFromStore(
  locationId: string
): Promise<GbpLocation | null> {
  const db = getDb();
  const doc = await db.collection("gbp_locations").doc(locationId).get();
  return doc.exists ? (doc.data() as GbpLocation) : null;
}

export async function saveLocationToStore(
  location: GbpLocation
): Promise<void> {
  const db = getDb();
  await db
    .collection("gbp_locations")
    .doc(location.locationId)
    .set(location, { merge: true });
}

export async function searchLocationsByName(
  name: string
): Promise<GbpLocation[]> {
  const db = getDb();
  const snap = await db
    .collection("gbp_locations")
    .where("name", ">=", name)
    .where("name", "<=", name + "\uf8ff")
    .get();
  return snap.docs.map((d) => d.data() as GbpLocation);
}
