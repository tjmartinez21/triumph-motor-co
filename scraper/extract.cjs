// Runs INSIDE a Facebook Marketplace listing page (via Playwright page.evaluate).
// Facebook embeds the listing as JSON in <script type="application/json"> tags.
// We walk that JSON looking for the object whose id matches the listing.
// Returns null if the listing data isn't on the page (removed, blocked, login wall).
function extractListing(listingId) {
  const blobs = [];
  for (const s of document.querySelectorAll('script[type="application/json"]')) {
    if (!s.textContent.includes(listingId)) continue;
    try { blobs.push(JSON.parse(s.textContent)); } catch (e) {}
  }
  const details = [];
  const photoSets = [];
  const seen = new Set();
  (function walk(o, depth) {
    if (!o || typeof o !== 'object' || depth > 80 || seen.has(o)) return;
    seen.add(o);
    if (o.id === listingId) {
      if ('marketplace_listing_title' in o || 'vehicle_odometer_data' in o) details.push(o);
      if (Array.isArray(o.listing_photos) && o.listing_photos.length) photoSets.push(o.listing_photos);
    }
    for (const k in o) walk(o[k], depth + 1);
  })(blobs, 0);

  if (!details.length) return null;
  // Merge every partial copy of the listing Facebook sent (fields are spread across several).
  const d = {};
  for (const part of details) for (const k in part) if (part[k] != null && d[k] == null) d[k] = part[k];
  const photos = (photoSets.sort((a, b) => b.length - a.length)[0] || [])
    .map(p => p && p.image && p.image.uri).filter(Boolean);

  const txt = v => (v && typeof v === 'object' ? v.text : v) || null;
  const nice = v => v ? String(v).toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : null;
  const owners = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 }[d.vehicle_number_of_owners] || null;
  const year = ((txt(d.custom_title) || d.marketplace_listing_title || '').match(/\b(19|20)\d{2}\b/) || [])[0];

  return {
    id: listingId,
    title: txt(d.custom_title) || d.marketplace_listing_title || null,
    year: year ? Number(year) : null,
    make: d.vehicle_make_display_name || null,
    model: d.vehicle_model_display_name || null,
    trim: d.vehicle_trim_display_name || null,
    price: d.listing_price ? Math.round(Number(d.listing_price.amount)) : null,
    priceText: txt(d.formatted_price),
    mileage: d.vehicle_odometer_data ? d.vehicle_odometer_data.value : null,
    mileageUnit: d.vehicle_odometer_data ? nice(d.vehicle_odometer_data.unit) : null,
    transmission: nice(d.vehicle_transmission_type),
    fuel: nice(d.vehicle_fuel_type),
    exteriorColor: nice(d.vehicle_exterior_color),
    interiorColor: nice(d.vehicle_interior_color),
    owners,
    paidOff: d.vehicle_is_paid_off === 'IS_PAID_OFF',
    titleStatus: nice(d.vehicle_title_status),
    vin: d.vehicle_identification_number || null,
    description: txt(d.redacted_description) || '',
    location: txt(d.location_text),
    sold: d.is_sold === true,
    pending: d.is_pending === true,
    live: d.is_live !== false && d.is_hidden !== true,
    listedAt: d.creation_time ? new Date(d.creation_time * 1000).toISOString() : null,
    photoUrls: photos,
    fbUrl: `https://www.facebook.com/marketplace/item/${listingId}/`,
  };
}
if (typeof module !== 'undefined') module.exports = { extractListing };
