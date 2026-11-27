// The same 200-property pool the agents rank. Reading names from here (instead of calling
// /properties/get for every card) keeps property.viewed events to real visits.
import data from '../../../../../data/property-pool-200.json';

const byId = new Map(data.properties.map((p) => [p.property_id, p]));
export const property = (id) => byId.get(id) || null;
export const title = (id) => byId.get(id)?.title || id;
export const propertiesIn = (city) => data.properties.filter((p) => !city || p.city === city);
