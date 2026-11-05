// The demo seed's cast (#351): who works at Acme Remote on top of the base seed, their
// teams, managers, places, shifts and habits, plus the org's clients, projects and
// tasks. Read by generate.ts; nothing here touches the database.
//
// Day offsets (`joinDay`, leave days, ...) are relative to the person's own local today
// (0 = today, -1 = yesterday).

export type Role = "owner" | "admin" | "manager" | "employee";

export interface ShiftDef {
  /** ISO weekdays, 1 = Monday. */
  days: number[];
  start: string;
  end: string;
}

/** Behaviour knobs; anything left out takes the steady default. */
export interface Habits {
  late: number;
  early: number;
  overtime: number;
  forget: number;
  noShow: number;
  miss: number;
  fail: number;
  missRunDays: number[];
  pauses: number;
  longPauseDays: number[];
  idle: number;
  locks: number;
  calls: number;
  sleep: number;
  drop: number;
  kill: number;
  flags: [string, number][];
  fast: boolean;
  cameraBusy: number;
  noFace: number;
  dual: number;
}

export const steady: Habits = {
  late: 0.05,
  early: 0.03,
  overtime: 0.1,
  forget: 0.02,
  noShow: 0.01,
  miss: 0.04,
  fail: 0.01,
  missRunDays: [],
  pauses: 0.5,
  longPauseDays: [],
  idle: 1,
  locks: 0.5,
  calls: 1,
  sleep: 0.04,
  drop: 0.03,
  kill: 0,
  flags: [],
  fast: false,
  cameraBusy: 0.02,
  noFace: 0.03,
  dual: 0.2,
};

/** What a live-crew member is doing when the seed finishes (Team grid, STS-02). */
export type LiveState =
  | "active"
  | "idle"
  | "on_break"
  | "paused"
  | "away_locked"
  | "away"
  | "in_meeting"
  | "offline"
  | "tamper";

export interface Person {
  key: string;
  /** Base-seed people keep their ids and rows; the demo only adds to them. */
  seed?: boolean;
  id: string;
  name: string;
  email: string;
  role: Role;
  manager: string | null;
  team: string | null;
  country: string;
  state: string | null;
  tz: string;
  shifts: ShiftDef[];
  /** A new shift from this day on (shift history, SHF-01). */
  shiftChange?: { fromDay: number; shifts: ShiftDef[] };
  habits: Partial<Habits>;
  /** Tracks time with the agent (has history). */
  tracked: boolean;
  /** Devices to register: 0, 1 or 2 (macOS, then Windows). */
  devices: number;
  /** Device 1 revoked on this day (laptop replaced); device 2 used from then on. */
  replaceDeviceDay?: number;
  joinDay?: number;
  /** Last working day; the device is handed back that evening, the account deactivated later. */
  lastDay?: number;
  invitedOnly?: boolean;
  live?: LiveState;
  approvalRequired?: boolean;
}

const MF = [1, 2, 3, 4, 5];
const day = (start: string, end: string, days = MF): ShiftDef[] => [{ days, start, end }];

let n = 0;
/** Demo people get ids in their own block: 00000000-0000-4000-8000-0000000d0NNN. */
function id(): string {
  n += 1;
  return `00000000-0000-4000-8000-0000000d${n.toString(16).padStart(4, "0")}`;
}
function email(name: string): string {
  return `${name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/'/g, "")
    .split(" ")
    .join(".")}@acme.test`;
}

type P = Omit<Person, "id" | "email" | "habits" | "tracked" | "devices"> &
  Partial<Pick<Person, "habits" | "tracked" | "devices">>;
function person(p: P): Person {
  return {
    id: id(),
    email: email(p.name),
    habits: {},
    tracked: p.role === "employee",
    devices: p.role === "employee" ? 1 : 0,
    ...p,
  };
}

const NY = "America/New_York";
const CHI = "America/Chicago";
const DEN = "America/Denver";
const PHX = "America/Phoenix";
const LA = "America/Los_Angeles";

export const people: Person[] = [
  // ---- base seed (rows exist; demo adds devices, history and decisions) ----
  {
    key: "ada",
    seed: true,
    id: "00000000-0000-4000-8000-0000000000a1",
    name: "Ada Admin",
    email: "admin@acme.test",
    role: "owner",
    manager: null,
    team: null,
    country: "US",
    state: "NY",
    tz: NY,
    shifts: [],
    habits: {},
    tracked: false,
    devices: 0,
  },
  {
    key: "max",
    seed: true,
    id: "00000000-0000-4000-8000-0000000000b1",
    name: "Max Manager",
    email: "manager@acme.test",
    role: "manager",
    manager: "ada",
    team: "support",
    country: "US",
    state: "IL",
    tz: CHI,
    shifts: [],
    habits: {},
    tracked: false,
    devices: 0,
  },
  {
    key: "erin",
    seed: true,
    id: "00000000-0000-4000-8000-0000000000c1",
    name: "Erin Employee",
    email: "erin@acme.test",
    role: "employee",
    manager: "max",
    team: "support",
    country: "US",
    state: "CA",
    tz: LA,
    shifts: day("09:00", "17:00"),
    habits: { flags: [["excluded_app", 0.05]] },
    tracked: true,
    devices: 1,
  },
  {
    key: "lucas",
    seed: true,
    id: "00000000-0000-4000-8000-0000000000c2",
    name: "Lucas Martin",
    email: "lucas@acme.test",
    role: "employee",
    manager: "max",
    team: "support",
    country: "US",
    state: "TX",
    tz: CHI,
    shifts: day("22:00", "06:00", [1, 2, 3, 4]),
    habits: { late: 0.2 },
    tracked: true,
    devices: 1,
  },

  // ---- managers and admins ----
  person({
    key: "priya",
    name: "Priya Raman",
    role: "admin",
    manager: "ada",
    team: "finance",
    country: "US",
    state: "NY",
    tz: NY,
    shifts: [],
  }),
  person({
    key: "daniel",
    name: "Daniel Okafor",
    role: "manager",
    manager: "ada",
    team: "product",
    country: "US",
    state: "GA",
    tz: NY,
    shifts: [],
  }),
  person({
    key: "sofia",
    name: "Sofia Herrera",
    role: "manager",
    manager: "daniel",
    team: "engineering",
    country: "US",
    state: "CO",
    tz: DEN,
    shifts: [],
  }),
  person({
    key: "kenji",
    name: "Kenji Watanabe",
    role: "manager",
    manager: "daniel",
    team: "design",
    country: "US",
    state: "WA",
    tz: LA,
    shifts: [],
  }),
  person({
    key: "grace",
    name: "Grace Liu",
    role: "manager",
    manager: "ada",
    team: "sales",
    country: "US",
    state: "MA",
    tz: NY,
    shifts: [],
  }),
  person({
    key: "omar",
    name: "Omar Haddad",
    role: "manager",
    manager: "priya",
    team: "nightops",
    country: "US",
    state: "AZ",
    tz: PHX,
    shifts: day("21:00", "05:00", [7, 1, 2, 3, 4]),
    tracked: true,
    devices: 1,
  }),
  person({
    key: "tom",
    name: "Tom Becker",
    role: "admin",
    manager: "ada",
    team: null,
    country: "US",
    state: "MN",
    tz: CHI,
    shifts: [],
  }),

  // ---- Support (Max) ----
  person({
    key: "aisha",
    name: "Aisha Bello",
    role: "employee",
    manager: "max",
    team: "support",
    country: "US",
    state: "IL",
    tz: CHI,
    shifts: day("08:00", "16:00"),
  }),
  person({
    key: "carlos",
    name: "Carlos Mendoza",
    role: "employee",
    manager: "max",
    team: "support",
    country: "US",
    state: "TX",
    tz: CHI,
    shifts: day("09:00", "17:00"),
    habits: { late: 0.45 },
  }),
  person({
    key: "hannah",
    name: "Hannah Kim",
    role: "employee",
    manager: "max",
    team: "support",
    country: "US",
    state: "NY",
    tz: NY,
    shifts: [
      { days: MF, start: "08:00", end: "12:00" },
      { days: MF, start: "15:00", end: "19:00" },
    ],
  }),
  person({
    key: "marcus",
    name: "Marcus Johnson",
    role: "employee",
    manager: "max",
    team: "support",
    country: "US",
    state: "GA",
    tz: NY,
    shifts: day("09:00", "17:00"),
    shiftChange: { fromDay: -10, shifts: day("12:00", "20:00") },
  }),
  person({
    key: "fatima",
    name: "Fatima Al-Sayed",
    role: "employee",
    manager: "max",
    team: "support",
    country: "US",
    state: "MI",
    tz: "America/Detroit",
    shifts: day("09:00", "17:00"),
    habits: { forget: 0.3 },
  }),
  person({
    key: "diego",
    name: "Diego Alvarez",
    role: "employee",
    manager: "max",
    team: "support",
    country: "US",
    state: "FL",
    tz: NY,
    shifts: day("08:00", "18:00", [5, 6, 7]),
  }),
  person({
    key: "mei",
    name: "Mei Chen",
    role: "employee",
    manager: "max",
    team: "support",
    country: "US",
    state: "CA",
    tz: LA,
    shifts: day("09:00", "13:00", [1, 3, 5]),
  }),
  person({
    key: "tyrone",
    name: "Tyrone Williams",
    role: "employee",
    manager: "max",
    team: "support",
    country: "US",
    state: "NC",
    tz: NY,
    shifts: day("10:00", "18:00"),
    habits: { miss: 0.12, missRunDays: [-1, -8, -15] },
  }),
  person({
    key: "olivia",
    name: "Olivia Brown",
    role: "employee",
    manager: "max",
    team: "support",
    country: "US",
    state: "OH",
    tz: NY,
    shifts: day("09:00", "17:00"),
    joinDay: -9,
  }),

  // ---- Engineering (Sofia): flexible hours; the live crew lives here ----
  person({
    key: "arjun",
    name: "Arjun Patel",
    role: "employee",
    manager: "sofia",
    team: "engineering",
    country: "US",
    state: "CA",
    tz: LA,
    shifts: [],
    live: "active",
    devices: 2,
    habits: { dual: 0.8 },
  }),
  person({
    key: "lena",
    name: "Lena Fischer",
    role: "employee",
    manager: "sofia",
    team: "engineering",
    country: "GB",
    state: null,
    tz: "Europe/London",
    shifts: [],
    live: "idle",
  }),
  person({
    key: "mateo",
    name: "Mateo Rossi",
    role: "employee",
    manager: "sofia",
    team: "engineering",
    country: "US",
    state: "CO",
    tz: DEN,
    shifts: [],
    live: "on_break",
  }),
  person({
    key: "yuki",
    name: "Yuki Tanaka",
    role: "employee",
    manager: "sofia",
    team: "engineering",
    country: "US",
    state: "WA",
    tz: LA,
    shifts: [],
    live: "paused",
    habits: { pauses: 2, longPauseDays: [-2, -9, -16] },
  }),
  person({
    key: "samuel",
    name: "Samuel Osei",
    role: "employee",
    manager: "sofia",
    team: "engineering",
    country: "US",
    state: "NY",
    tz: NY,
    shifts: [],
    live: "away_locked",
    habits: { locks: 2 },
  }),
  person({
    key: "ines",
    name: "Ines Duarte",
    role: "employee",
    manager: "sofia",
    team: "engineering",
    country: "US",
    state: "TX",
    tz: CHI,
    shifts: [],
    live: "away",
    habits: { miss: 0.1, missRunDays: [-3, -10] },
  }),
  person({
    key: "noah",
    name: "Noah Goldberg",
    role: "employee",
    manager: "sofia",
    team: "engineering",
    country: "US",
    state: "NY",
    tz: NY,
    shifts: [],
    live: "in_meeting",
    habits: { calls: 3.5 },
  }),
  person({
    key: "kwame",
    name: "Kwame Mensah",
    role: "employee",
    manager: "sofia",
    team: "engineering",
    country: "US",
    state: "UT",
    tz: DEN,
    shifts: [],
    live: "offline",
    habits: { drop: 0.35, sleep: 0.2 },
  }),
  person({
    key: "ravi",
    name: "Ravi Iyer",
    role: "employee",
    manager: "sofia",
    team: "engineering",
    country: "US",
    state: "CA",
    tz: LA,
    shifts: [],
    live: "tamper",
    habits: { kill: 0.25 },
  }),
  person({
    key: "chloe",
    name: "Chloe Martin",
    role: "employee",
    manager: "sofia",
    team: "engineering",
    country: "US",
    state: "OR",
    tz: LA,
    shifts: day("09:00", "17:00"),
    habits: { fast: true, miss: 0.01, flags: [["synthetic_click:2", 0.12]] },
  }),
  person({
    key: "ben",
    name: "Ben Carter",
    role: "employee",
    manager: "sofia",
    team: "engineering",
    country: "US",
    state: "AZ",
    tz: PHX,
    shifts: day("08:00", "16:00"),
    habits: {
      flags: [
        ["virtual_machine", 0.15],
        ["remote_session", 0.1],
      ],
    },
  }),
  person({
    key: "zara",
    name: "Zara Ahmed",
    role: "employee",
    manager: "sofia",
    team: "engineering",
    country: "US",
    state: "IL",
    tz: CHI,
    shifts: day("10:00", "18:00"),
    devices: 2,
    replaceDeviceDay: -12,
  }),

  // ---- Design (Kenji) ----
  person({
    key: "isabella",
    name: "Isabella Moreno",
    role: "employee",
    manager: "kenji",
    team: "design",
    country: "US",
    state: "CA",
    tz: LA,
    shifts: day("09:00", "17:00"),
  }),
  person({
    key: "liam",
    name: "Liam O'Connor",
    role: "employee",
    manager: "kenji",
    team: "design",
    country: "US",
    state: "NV",
    tz: LA,
    shifts: day("09:00", "17:00"),
    habits: { early: 0.35 },
  }),
  person({
    key: "ana",
    name: "Ana Souza",
    role: "employee",
    manager: "kenji",
    team: "design",
    country: "US",
    state: "HI",
    tz: "Pacific/Honolulu",
    shifts: day("08:00", "16:00"),
  }),
  person({
    key: "jonas",
    name: "Jonas Berg",
    role: "employee",
    manager: "kenji",
    team: "design",
    country: "US",
    state: "AK",
    tz: "America/Anchorage",
    shifts: day("09:00", "17:00"),
    habits: { flags: [["virtual_camera:OBS Virtual Camera", 0.08]] },
  }),
  person({
    key: "emily",
    name: "Emily Nguyen",
    role: "employee",
    manager: "kenji",
    team: "design",
    country: "US",
    state: "CA",
    tz: LA,
    shifts: day("09:00", "17:00"),
  }),
  person({
    key: "kofi",
    name: "Kofi Asante",
    role: "employee",
    manager: "kenji",
    team: "design",
    country: "US",
    state: "WA",
    tz: LA,
    shifts: day("13:00", "18:00", [2, 4]),
  }),

  // ---- Sales (Grace) ----
  person({
    key: "sophie",
    name: "Sophie Laurent",
    role: "employee",
    manager: "grace",
    team: "sales",
    country: "CA",
    state: null,
    tz: "America/Toronto",
    shifts: day("09:00", "17:00"),
  }),
  person({
    key: "jamal",
    name: "Jamal Robinson",
    role: "employee",
    manager: "grace",
    team: "sales",
    country: "US",
    state: "NY",
    tz: NY,
    shifts: day("09:00", "17:00"),
    habits: { late: 0.35 },
  }),
  person({
    key: "rachel",
    name: "Rachel Cohen",
    role: "employee",
    manager: "grace",
    team: "sales",
    country: "US",
    state: "NJ",
    tz: NY,
    shifts: day("09:00", "17:00"),
    habits: { flags: [["duplicate_frame:3", 0.06]] },
  }),
  person({
    key: "pedro",
    name: "Pedro Santos",
    role: "employee",
    manager: "grace",
    team: "sales",
    country: "US",
    state: "FL",
    tz: NY,
    shifts: day("08:00", "16:00"),
    lastDay: -8,
  }),
  person({
    key: "nina",
    name: "Nina Petrova",
    role: "employee",
    manager: "grace",
    team: "sales",
    country: "US",
    state: "PA",
    tz: NY,
    shifts: day("09:00", "17:00"),
  }),
  person({
    key: "hiroshi",
    name: "Hiroshi Sato",
    role: "employee",
    manager: "grace",
    team: "sales",
    country: "US",
    state: "IL",
    tz: CHI,
    shifts: day("09:00", "17:00"),
    habits: { calls: 3 },
  }),
  person({
    key: "valentina",
    name: "Valentina Cruz",
    role: "employee",
    manager: "grace",
    team: "sales",
    country: "US",
    state: "CA",
    tz: LA,
    shifts: day("09:00", "17:00"),
  }),
  person({
    key: "ethan",
    name: "Ethan Walker",
    role: "employee",
    manager: "grace",
    team: "sales",
    country: "US",
    state: "TX",
    tz: CHI,
    shifts: [],
    invitedOnly: true,
    tracked: false,
    devices: 0,
  }),

  // ---- Night Ops (Omar): nights, evenings, weekends ----
  person({
    key: "malik",
    name: "Malik Thompson",
    role: "employee",
    manager: "omar",
    team: "nightops",
    country: "US",
    state: "AZ",
    tz: PHX,
    shifts: day("22:00", "06:00", [7, 1, 2, 3, 4]),
  }),
  person({
    key: "sara",
    name: "Sara Lindqvist",
    role: "employee",
    manager: "omar",
    team: "nightops",
    country: "US",
    state: "NV",
    tz: LA,
    shifts: day("23:00", "07:00"),
  }),
  person({
    key: "ahmed",
    name: "Ahmed Hassan",
    role: "employee",
    manager: "omar",
    team: "nightops",
    country: "US",
    state: "TX",
    tz: CHI,
    shifts: day("06:00", "18:00", [6, 7]),
  }),
  person({
    key: "gabriela",
    name: "Gabriela Ruiz",
    role: "employee",
    manager: "omar",
    team: "nightops",
    country: "US",
    state: "NM",
    tz: DEN,
    shifts: day("16:00", "00:00"),
  }),
  person({
    key: "tomasz",
    name: "Tomasz Nowak",
    role: "employee",
    manager: "omar",
    team: "nightops",
    country: "US",
    state: "IL",
    tz: CHI,
    shifts: day("21:00", "05:00", [1, 2, 3, 4]),
    habits: { forget: 0.25 },
  }),
  person({
    key: "leah",
    name: "Leah Friedman",
    role: "employee",
    manager: "omar",
    team: "nightops",
    country: "US",
    state: "CO",
    tz: DEN,
    shifts: day("06:00", "14:00"),
  }),
  person({
    key: "darnell",
    name: "Darnell Jackson",
    role: "employee",
    manager: "omar",
    team: "nightops",
    country: "US",
    state: "GA",
    tz: NY,
    shifts: day("22:00", "06:00", [2, 3, 4, 5, 6]),
    habits: { pauses: 1.5, longPauseDays: [-4, -11] },
  }),

  // ---- Finance & People (Priya) ----
  person({
    key: "catherine",
    name: "Catherine Dubois",
    role: "employee",
    manager: "priya",
    team: "finance",
    country: "US",
    state: "NY",
    tz: NY,
    shifts: day("09:00", "17:00"),
  }),
  person({
    key: "victor",
    name: "Victor Huang",
    role: "employee",
    manager: "priya",
    team: "finance",
    country: "US",
    state: "CA",
    tz: LA,
    shifts: day("10:00", "14:00", [1, 2, 3, 4]),
  }),
  person({
    key: "amara",
    name: "Amara Okeke",
    role: "employee",
    manager: "priya",
    team: "finance",
    country: "US",
    state: "MD",
    tz: NY,
    shifts: day("09:00", "17:00"),
  }),
  person({
    key: "lucia",
    name: "Lucia Romano",
    role: "employee",
    manager: "priya",
    team: "finance",
    country: "US",
    state: "MA",
    tz: NY,
    shifts: day("08:30", "16:30"),
    habits: { early: 0.3 },
  }),
  person({
    key: "owen",
    name: "Owen Murphy",
    role: "employee",
    manager: "priya",
    team: "finance",
    country: "US",
    state: "WI",
    tz: CHI,
    shifts: day("09:00", "17:00"),
    habits: { late: 0.3 },
  }),
  person({
    key: "priyanka",
    name: "Priyanka Shah",
    role: "employee",
    manager: "priya",
    team: "finance",
    country: "US",
    state: "NJ",
    tz: NY,
    shifts: day("09:00", "17:00"),
  }),
  person({
    key: "andre",
    name: "Andre Silva",
    role: "employee",
    manager: "priya",
    team: "finance",
    country: "US",
    state: "CT",
    tz: NY,
    shifts: day("07:00", "15:00"),
    approvalRequired: false,
  }),

  // ---- Product (Daniel's direct reports) ----
  person({
    key: "rosa",
    name: "Rosa Jimenez",
    role: "employee",
    manager: "daniel",
    team: "product",
    country: "US",
    state: "CA",
    tz: LA,
    shifts: [],
  }),
  person({
    key: "william",
    name: "William Scott",
    role: "employee",
    manager: "daniel",
    team: "product",
    country: "US",
    state: "NY",
    tz: NY,
    shifts: day("09:00", "17:00"),
  }),
  person({
    key: "mariam",
    name: "Mariam Yusuf",
    role: "employee",
    manager: "daniel",
    team: "product",
    country: "US",
    state: "MN",
    tz: CHI,
    shifts: day("09:00", "17:00"),
    joinDay: -5,
  }),
];

export const byKey = new Map(people.map((p) => [p.key, p]));

export const teams: { key: string; name: string; billableTarget?: number }[] = [
  { key: "support", name: "Support", billableTarget: 60 },
  { key: "engineering", name: "Engineering", billableTarget: 75 },
  { key: "design", name: "Design" },
  { key: "sales", name: "Sales" },
  { key: "nightops", name: "Night Ops" },
  { key: "finance", name: "Finance & People" },
  { key: "product", name: "Product" },
];

// Clients, projects and tasks. `fake` ids stand in for the real ones in generated
// events until the database has created them (generate.ts / 10_setup.sql map them).
export interface Project {
  key: string;
  fake: string;
  name: string;
  client: string | null;
  billable: boolean;
  archived?: boolean;
  /** Existing base-seed project id, if any. */
  seedId?: string;
  teams: string[];
  tasks: { key: string; fake: string; name: string }[];
}

export const clients = [
  { key: "northwind", name: "Northwind", seedId: "00000000-0000-4000-8000-0000000000e1" },
  { key: "contoso", name: "Contoso" },
  { key: "globex", name: "Globex" },
  { key: "initech", name: "Initech" },
  { key: "umbrella", name: "Umbrella Health" },
];

let pn = 0;
let tn = 0;
const pid = () => `00000000-0000-4000-a000-0000000000${(++pn).toString(16).padStart(2, "0")}`;
const tasks = (...names: string[]) =>
  names.map((name) => ({
    key: name.toLowerCase(),
    fake: `00000000-0000-4000-b000-0000000000${(++tn).toString(16).padStart(2, "0")}`,
    name,
  }));

export const projects: Project[] = [
  {
    key: "website",
    fake: pid(),
    name: "Website revamp",
    client: "northwind",
    billable: true,
    seedId: "00000000-0000-4000-8000-0000000000f1",
    teams: ["support", "engineering", "design"],
    tasks: tasks("Design", "Frontend", "QA"),
  },
  {
    key: "internal",
    fake: pid(),
    name: "Internal",
    client: null,
    billable: false,
    seedId: "00000000-0000-4000-8000-0000000000f2",
    teams: ["support", "engineering", "design", "sales", "nightops", "finance", "product"],
    tasks: tasks("Meetings", "Admin", "Training"),
  },
  {
    key: "mobile",
    fake: pid(),
    name: "Mobile app",
    client: "contoso",
    billable: true,
    teams: ["engineering", "design", "product"],
    tasks: tasks("iOS", "Android", "API"),
  },
  {
    key: "migration",
    fake: pid(),
    name: "Data migration",
    client: "globex",
    billable: true,
    teams: ["engineering", "nightops"],
    tasks: tasks("Mapping", "Scripts", "Validation"),
  },
  {
    key: "campaign",
    fake: pid(),
    name: "Q4 campaign",
    client: "initech",
    billable: true,
    teams: ["sales", "design"],
    tasks: tasks("Outreach", "Proposals"),
  },
  {
    key: "retainer",
    fake: pid(),
    name: "Support retainer",
    client: "umbrella",
    billable: true,
    teams: ["support", "nightops"],
    tasks: tasks("Tickets", "Escalations"),
  },
  {
    key: "tooling",
    fake: pid(),
    name: "Ops tooling",
    client: null,
    billable: false,
    teams: ["engineering", "nightops"],
    tasks: [],
  },
  {
    key: "hiring",
    fake: pid(),
    name: "Hiring",
    client: null,
    billable: false,
    teams: ["finance", "product"],
    tasks: tasks("Interviews"),
  },
  {
    key: "legacy",
    fake: pid(),
    name: "Legacy CRM",
    client: "globex",
    billable: true,
    archived: true,
    teams: [],
    tasks: [],
  },
];

/** What each team has in front of it, by weight; browsers carry a domain. */
export const apps: Record<string, [string, string | null, string[], number][]> = {
  support: [
    [
      "Google Chrome",
      "acme.zendesk.com",
      ["Ticket #48213 · Refund request", "Views · Open tickets"],
      5,
    ],
    ["Slack", null, ["#support-escalations", "Direct message"], 2],
    ["Google Chrome", "mail.google.com", ["Inbox (14)", "Re: Invoice question"], 2],
    ["Notion", null, ["Support playbook", "Macros"], 1],
  ],
  engineering: [
    ["Visual Studio Code", null, ["sync.rs — agent", "status.ts — core", "README.md"], 6],
    ["Terminal", null, ["cargo test", "pnpm dev"], 2],
    ["Google Chrome", "github.com", ["Pull request #412", "Actions · CI"], 3],
    ["Google Chrome", "stackoverflow.com", ["How to batch inserts in Postgres"], 1],
    ["Slack", null, ["#eng", "Direct message"], 2],
  ],
  design: [
    ["Figma", null, ["Checkout flow v3", "Design system"], 6],
    ["Google Chrome", "dribbble.com", ["Inspiration"], 1],
    ["Adobe Photoshop", null, ["hero-banner.psd"], 2],
    ["Slack", null, ["#design-crit"], 2],
  ],
  sales: [
    ["Google Chrome", "acme.lightning.force.com", ["Opportunity · Initech renewal", "Pipeline"], 5],
    ["Google Chrome", "linkedin.com", ["Sales Navigator"], 2],
    ["Microsoft Excel", null, ["Q4 forecast.xlsx"], 2],
    ["Slack", null, ["#deals"], 2],
  ],
  nightops: [
    ["Google Chrome", "app.datadoghq.com", ["Dashboards · API latency"], 4],
    ["Terminal", null, ["ssh bastion", "kubectl get pods"], 3],
    ["Google Chrome", "acme.pagerduty.com", ["Incidents"], 2],
    ["Slack", null, ["#ops-night"], 2],
  ],
  finance: [
    ["Microsoft Excel", null, ["October close.xlsx", "Payroll reconciliation.xlsx"], 5],
    ["Google Chrome", "app.qbo.intuit.com", ["Bills", "Reports"], 3],
    ["Microsoft Word", null, ["Policy update.docx"], 1],
    ["Slack", null, ["#finance"], 1],
  ],
  product: [
    ["Google Chrome", "linear.app", ["Roadmap · Q1", "Issue PRD-88"], 4],
    ["Notion", null, ["Discovery notes"], 2],
    ["Figma", null, ["Mobile app flows"], 1],
    ["Slack", null, ["#product"], 2],
  ],
};
