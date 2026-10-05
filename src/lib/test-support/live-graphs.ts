import type { FlowGraph } from "../flow-graph";

/** Test-only fixtures, shared by the batch tests. Never used by the app. */

// The live published graphs (Oct 2026), as stored. Only the welcome picture's
// address is swapped for a neutral one.
export const WELCOME_PNG = "https://cdn.example.com/zoori/welcome.png";
export const ZOORI_LIVE: FlowGraph = {
  meta: {},
  edges: [
    { id: "emuuxeb2eo", source: "nmuux8kg1a", target: "nmuuxdr6bn", sourceHandle: "rmuux8kg1b" },
    { id: "emuuxeccpp", source: "nmuux8kg1a", target: "nmuuxdr6bn", sourceHandle: "rmuux98jqc" },
    { id: "emuuxee0vq", source: "nmuux8kg1a", target: "nmuuxdr6bn", sourceHandle: "rmuux9gv4d" },
    { id: "emuuxefjzr", source: "nmuux8kg1a", target: "nmuuxdr6bn", sourceHandle: "rmuux9s7xe" },
    { id: "emuuxggbfu", source: "start", target: "nmuux3n080", sourceHandle: "next" },
    { id: "emuuxlzx116", source: "nmuux5sj22", target: "nmuux8kg1a", sourceHandle: "rmuux5sj23" },
    { id: "emuuxm1hi17", source: "nmuux5sj22", target: "nmuux8kg1a", sourceHandle: "rmuux6yaf5" },
    { id: "emuuxm3at18", source: "nmuux5sj22", target: "nmuux8kg1a", sourceHandle: "rmuux72jo6" },
    { id: "emuuxm4zw19", source: "nmuux5sj22", target: "nmuux8kg1a", sourceHandle: "rmuux78u37" },
    { id: "emuuxme3p1b", source: "nmuuxj5rrv", target: "nmuux5sj22", sourceHandle: "rmuuxjy89y" },
    { id: "emuuxmfj31c", source: "nmuuxj5rrv", target: "nmuux5sj22", sourceHandle: "rmuuxjztcz" },
    { id: "emuuxmh2n1d", source: "nmuuxj5rrv", target: "nmuux5sj22", sourceHandle: "rmuuxk5zx10" },
    { id: "emuuxms1j1e", source: "nmuuxj5rrv", target: "nmuux5sj22", sourceHandle: "window_closed" },
    { id: "emuuxn2941f", source: "nmuux3n080", target: "nmuuxj5rrv", sourceHandle: "window_closed" },
    { id: "emuuxn5vp1g", source: "nmuux3n080", target: "nmuuxj5rrv", sourceHandle: "next" },
    { id: "emuuxndns1h", source: "nmuuxj5rrv", target: "nmuux5sj22", sourceHandle: "rmuuxj5rrw" },
    { id: "emuuxnhio1i", source: "nmuux5sj22", target: "nmuux8kg1a", sourceHandle: "window_closed" },
    { id: "emuuxorop1j", source: "nmuuxj5rrv", target: "nmuux5sj22", sourceHandle: "rmuuxjsk4x" },
    { id: "emuuxueg81o", source: "nmuuxtp2h1l", target: "end", sourceHandle: "next" },
    { id: "emuuy9xyd1v", source: "nmuuxdr6bn", target: "nmuuy3uxn1p", sourceHandle: "next" },
    { id: "emuuya0kd1w", source: "nmuuxdr6bn", target: "nmuuy3uxn1p", sourceHandle: "window_closed" },
    { id: "emuuyaee21x", source: "nmuuy3uxn1p", target: "nmuuy7ry21t", sourceHandle: "next" },
    { id: "emuuyagdc1y", source: "nmuuy7ry21t", target: "nmuuy6pfy1s", sourceHandle: "next" },
    { id: "emuuyajk51z", source: "nmuuy6pfy1s", target: "nmuuy8mdw1u", sourceHandle: "next" },
    { id: "emuuyan6820", source: "nmuuy8mdw1u", target: "nmuuxtp2h1l", sourceHandle: "next" },
  ],
  nodes: [
    { id: "start", data: { label: "hello, hey, hi" }, type: "start", position: { x: -371, y: -146 } },
    { id: "end", data: {}, type: "end", position: { x: 2045, y: 12 } },
    { id: "nmuux3n080", data: { text: "Hi {{name}} Welcome to Zoori ✨ ", label: "step 1", image_url: WELCOME_PNG }, type: "text", position: { x: -80, y: -224 } },
    {
      id: "nmuux5sj22",
      data: {
        rows: [
          { id: "rmuux5sj23", title: "Diamond" },
          { id: "rmuux6yaf5", title: "Gemstone" },
          { id: "rmuux72jo6", title: "Pearl" },
          { id: "rmuux78u37", title: "Gold" },
        ],
        text: "Which stone are you looking for",
        label: "stone",
        variable: "stones",
        button_text: "Choose",
      },
      type: "list",
      position: { x: 545, y: -227 },
    },
    {
      id: "nmuux8kg1a",
      data: {
        rows: [
          { id: "rmuux8kg1b", title: "Under 25k" },
          { id: "rmuux98jqc", title: "₹25k–50k" },
          { id: "rmuux9gv4d", title: "₹50k–1L" },
          { id: "rmuux9s7xe", title: "Above ₹1L" },
        ],
        text: "What's your budget?",
        label: "Budget",
        variable: "budget",
        button_text: "Choose",
      },
      type: "list",
      position: { x: 868, y: -226 },
    },
    { id: "nmuuxdr6bn", data: { text: "Thank you! Our team will get back to you soon.", label: "end" }, type: "text", position: { x: 1193, y: -186 } },
    {
      id: "nmuuxj5rrv",
      data: {
        rows: [
          { id: "rmuuxj5rrw", title: "Rings" },
          { id: "rmuuxjsk4x", title: "Pendants" },
          { id: "rmuuxjy89y", title: "Tanmaniya" },
          { id: "rmuuxjztcz", title: "Bracelets" },
          { id: "rmuuxk5zx10", title: "Earrings" },
        ],
        text: "What are you looking for?",
        label: "product",
        variable: "product",
        button_text: "Choose",
      },
      type: "list",
      position: { x: 251, y: -236 },
    },
    { id: "nmuuxtp2h1l", data: { label: "assign to team", user_id: "" }, type: "assign", position: { x: 1767, y: -51 } },
    { id: "nmuuy3uxn1p", data: { tag: "WhatsApp lead", label: "zoori", action: "add" }, type: "tag", position: { x: 1434, y: 43 } },
    { id: "nmuuy6pfy1s", data: { field: "interest", label: "interest", value: "{{product}}" }, type: "set_field", position: { x: 1627, y: 294 } },
    { id: "nmuuy7ry21t", data: { field: "budget", value: "{{budget}}" }, type: "set_field", position: { x: 1349, y: 242 } },
    { id: "nmuuy8mdw1u", data: { field: "stone", value: "{{stones}}" }, type: "set_field", position: { x: 1933, y: 208 } },
  ],
};

export const AIDWAR_WELCOME: FlowGraph = {
  meta: {},
  edges: [
    { id: "e0", source: "start", target: "menu", sourceHandle: "next" },
    { id: "e1", source: "menu", target: "shop", sourceHandle: "b1" },
    { id: "e2", source: "menu", target: "track", sourceHandle: "b2" },
    { id: "e3", source: "menu", target: "team", sourceHandle: "b3" },
    { id: "e4", source: "shop", target: "end", sourceHandle: "next" },
    { id: "e5", source: "track", target: "end", sourceHandle: "next" },
    { id: "e6", source: "team", target: "end", sourceHandle: "next" },
  ],
  nodes: [
    { id: "start", data: {}, type: "start", position: { x: 80, y: 60 } },
    {
      id: "menu",
      data: {
        text: "Hi {{name}}! How can we help?",
        buttons: [
          { id: "b1", title: "Shop" },
          { id: "b2", title: "Track order" },
          { id: "b3", title: "Talk to us" },
        ],
      },
      type: "buttons",
      position: { x: 380, y: 60 },
    },
    { id: "shop", data: { text: "Browse our latest picks on our website." }, type: "text", position: { x: 680, y: 60 } },
    { id: "track", data: { text: "Please share your order number and we'll check." }, type: "text", position: { x: 80, y: 260 } },
    { id: "team", data: {}, type: "assign", position: { x: 380, y: 260 } },
    { id: "end", data: {}, type: "end", position: { x: 680, y: 260 } },
  ],
};
