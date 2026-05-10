/**
 * Demo restaurants shown in the voice-session picker widget.
 * `workflow_update_reservation_slots` maps restaurantId to display name here.
 */
export interface DummyVoiceRestaurant {
  id: string;
  name: string;
  cuisine: string;
  rating: number;
  area: string;
}

export const DUMMY_VOICE_RESTAURANTS: DummyVoiceRestaurant[] = [
  { id: "luigis", name: "Luigi's Trattoria", cuisine: "Italian", rating: 4.8, area: "North End" },
  { id: "golden-fork", name: "The Golden Fork", cuisine: "Modern European", rating: 4.6, area: "Downtown" },
  { id: "sakura", name: "Sakura Garden", cuisine: "Japanese", rating: 4.7, area: "Waterfront" },
  { id: "maison-bleu", name: "Maison Bleu", cuisine: "French", rating: 4.9, area: "Arts District" },
  { id: "el-rancho", name: "El Rancho", cuisine: "Mexican", rating: 4.5, area: "Market Street" },
];
