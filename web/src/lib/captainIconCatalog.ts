// Every Captain icon (shared/captainIcons.ts) as its component: lucide's (ISC, licenses/lucide.txt) and the yard's own
// cap and helm. Only the picker and a Captain whose icon isn't built in load it (lib/captainIcon.tsx), so the first
// screen doesn't carry ~430 icons; test/bundle-split.test.ts keeps it out. Typed by id, so an id in the list without a
// component here fails the typecheck.
import type { LucideIcon } from "lucide-react"
import {
  Activity, AlarmClock, Ampersand, Anchor, Antenna, Anvil, Apple, Archive, Asterisk, AtSign, Atom, Avocado, Award, Axe, Baby, Backpack, Bacon, Badge,
  BadgeCheck, Balloon, Banana, Banknote, Beaker, Bean, Beef, Beer, Bell, BicepsFlexed, Bike, Binary, Binoculars, Biohazard, Bird, Birdhouse, Blocks,
  Bluetooth, Bolt, Bomb, Bone, Book, Bookmark, Bot, BotMessageSquare, BowArrow, Box, Boxes, Braces, Brackets, Brain, BrainCircuit, BrainCog, Bridge,
  Briefcase, Broccoli, Broom, Brush, Bug, Building, BuildingComplex, Bus, CableCar, Cake, CakeSlice, Calculator, Calendar, Camera, Candy, CandyCane,
  Car, Caravan, Carrot, CassetteTape, Castle, Cat, Certificate, ChartColumn, Check, ChefHat, Cherry, ChessBishop, ChessKing, ChessKnight, ChessPawn,
  ChessQueen, ChessRook, Church, Circle, CircuitBoard, Citrus, Clapperboard, Clipboard, Clock, Cloud, CloudLightning, CloudSun, Clover, Club, Code,
  Coffee, Cog, Coins, Compass, Component, Computer, Construction, ContactRound, Container, Cookie, CookingPot, Cpu, CpuAi, CreditCard, Croissant,
  Cross, Crosshair, Crown, CupSoda, Cupcake, Dam, Database, Dessert, Diamond, Dice5, Dices, Disc3, Dog, Donut, Drama, Drill, Drone, Droplet, Drum,
  Drumstick, Dumbbell, Ear, Earth, Eclipse, Egg, EighthNotes, Eraser, Eye, FaceAngry, FaceExpressionless, FaceGrinning, FaceNeutral,
  FaceSlightlyFrowning, FaceSlightlySmiling, Factory, Feather, FerrisWheel, FileIcon, Film, FingerprintPattern, Fish, FishSymbol, FishingHook, FishingRod,
  Flag, FlagTriangleRight, Flame, Flashlight, FlaskConical, Flower, Flower2, Focus, Folder, Footprints, Forklift, Fuel, Galaxy, Gamepad, Gamepad2,
  Gauge, Gavel, Gem, Ghost, Gift, GitBranch, GitCommitHorizontal, GitMerge, GitPullRequest, Glasses, Globe, Goal, GraduationCap, Grape, Guitar,
  GuitarElectric, Ham, Hamburger, Hammer, Hand, HandHelping, Handshake, HardDrive, HardHat, Hash, HatGlasses, Haze, Headphones, Headset, Heart,
  HeartPulse, Helicopter, Hexagon, Highlighter, Hospital, Hotel, Hourglass, House, IceCreamCone, Inbox, InfinityIcon, Joystick, Kanban, Kayak, Key,
  Keyboard, Lambda, Lamp, Landmark, Laptop, Layers, Leaf, LeafyGreen, Lectern, Library, LifeBuoy, Lightbulb, Lighthouse, Lock, Lollipop, Luggage,
  Magnet, Mail, MapIcon, MapPin, Martini, Medal, Megaphone, MessageCircle, Metronome, Mic, Microchip, Microscope, Milestone, Milk, Monitor, Moon,
  MoonStar, Motorbike, Mountain, MountainSnow, Mouse, Network, Newspaper, Notebook, Nut, Octagon, Omega, Orbit, Origami, Package, PaintBucket,
  PaintRoller, Paintbrush, Palette, Panda, Parasol, PartyPopper, PawPrint, PenTool, Pencil, Pentagon, PersonStanding, Phone, Pi, Piano, Pickaxe,
  PiggyBank, Pizza, Plane, Plug, Plus, Podium, Popcorn, Popsicle, Presentation, Printer, Puzzle, QrCode, Rabbit, Radar, Radiation, Radio, Rainbow,
  Rat, Receipt, Recycle, Ribbon, RobotArm, RobotVacuum, Rocket, RollerCoaster, Rose, Route, RugbyBall, Ruler, Sailboat, Salad, Sandwich, Satellite,
  SatelliteDish, Scale, School, Scissors, Scooter, Screw, Send, Server, Shapes, Shell, Shield, ShieldCheck, ShieldHalf, Ship, ShipCargo, ShipWheel,
  ShoppingBag, ShoppingCart, Shovel, Shrimp, Shrub, Signpost, Skull, Smartphone, Snail, Snowflake, Soup, Spade, Sparkle, Sparkles, Speech, Spool,
  Sprout, Square, Squircle, Squirrel, Stamp, Star, StickyNote, Stone, Store, Sun, Sunrise, Sunset, Sword, Swords, Tag, Target, Telescope, Tent,
  TentTree, Terminal, TestTube, TicTacToe, TicketsPlane, Timer, ToolCase, Toolbox, Tornado, TowerControl, ToyBrick, Tractor, TrafficCone, TrainFront,
  TramFront, TreeDeciduous, TreePalm, TreePine, Trees, TrendingUp, Triangle, Trophy, Truck, Turntable, Turtle, Tv, Umbrella, University, Usb, User,
  UserRound, Users, Utensils, VenetianMask, Volleyball, Wallet, Wand, WandSparkles, Warehouse, Watch, WavesHorizontal, WavesLadder, Waypoints, Webcam,
  Wheat, Wifi, Wind, Wine, Workflow, Worm, Wrench, Zap, ZodiacAquarius, ZodiacAries, ZodiacCancer, ZodiacCapricorn, ZodiacGemini, ZodiacLeo,
  ZodiacLibra, ZodiacPisces, ZodiacSagittarius, ZodiacScorpio, ZodiacTaurus, ZodiacVirgo
} from "lucide-react"
import { CaptainCap, Helm } from "../components/ShipIcons"
import type { CaptainIconId } from "../../../shared/captainIcons"

export const CAPTAIN_ICON_COMPONENTS: Record<CaptainIconId, LucideIcon> = {
  // Box Yard
  "captain-cap": CaptainCap, helm: Helm, bot: Bot,
  // Sea
  anchor: Anchor, ship: Ship, "ship-wheel": ShipWheel, sailboat: Sailboat, "ship-cargo": ShipCargo, "life-buoy": LifeBuoy, lighthouse: Lighthouse,
  compass: Compass, map: MapIcon, telescope: Telescope, binoculars: Binoculars, "waves-horizontal": WavesHorizontal, fish: Fish,
  "fishing-hook": FishingHook, "fishing-rod": FishingRod, shell: Shell, shrimp: Shrimp, kayak: Kayak, parasol: Parasol, "waves-ladder": WavesLadder,
  // Rank & awards
  crown: Crown, medal: Medal, award: Award, trophy: Trophy, star: Star, badge: Badge, "badge-check": BadgeCheck, shield: Shield,
  "shield-check": ShieldCheck, "shield-half": ShieldHalf, gem: Gem, ribbon: Ribbon, flag: Flag, "flag-triangle-right": FlagTriangleRight,
  "graduation-cap": GraduationCap, podium: Podium, goal: Goal, certificate: Certificate, stamp: Stamp, "chess-king": ChessKing,
  "chess-queen": ChessQueen, "chess-knight": ChessKnight, "chess-rook": ChessRook, "chess-bishop": ChessBishop, "chess-pawn": ChessPawn,
  // Bots & minds
  "bot-message-square": BotMessageSquare, brain: Brain, "brain-circuit": BrainCircuit, "brain-cog": BrainCog, cpu: Cpu, "cpu-ai": CpuAi,
  microchip: Microchip, "circuit-board": CircuitBoard, "robot-arm": RobotArm, "robot-vacuum": RobotVacuum, sparkles: Sparkles,
  "wand-sparkles": WandSparkles, atom: Atom, orbit: Orbit, radar: Radar, satellite: Satellite, "satellite-dish": SatelliteDish, antenna: Antenna,
  network: Network, waypoints: Waypoints, workflow: Workflow, infinity: InfinityIcon, lambda: Lambda, binary: Binary,
  // People
  user: User, "user-round": UserRound, users: Users, baby: Baby, "person-standing": PersonStanding, "contact-round": ContactRound,
  "face-slightly-smiling": FaceSlightlySmiling, "face-grinning": FaceGrinning, "face-angry": FaceAngry, "face-expressionless": FaceExpressionless,
  "face-neutral": FaceNeutral, "face-slightly-frowning": FaceSlightlyFrowning, ghost: Ghost, skull: Skull, "venetian-mask": VenetianMask,
  drama: Drama, glasses: Glasses, "hat-glasses": HatGlasses, "hard-hat": HardHat, "chef-hat": ChefHat, footprints: Footprints, hand: Hand,
  handshake: Handshake, "hand-helping": HandHelping, "biceps-flexed": BicepsFlexed, ear: Ear, eye: Eye, heart: Heart, speech: Speech,
  megaphone: Megaphone,
  // Animals
  cat: Cat, dog: Dog, bird: Bird, rabbit: Rabbit, rat: Rat, snail: Snail, squirrel: Squirrel, turtle: Turtle, panda: Panda, bug: Bug, worm: Worm,
  "paw-print": PawPrint, egg: Egg, feather: Feather, bone: Bone, birdhouse: Birdhouse, "fish-symbol": FishSymbol,
  // Nature
  leaf: Leaf, "leafy-green": LeafyGreen, sprout: Sprout, flower: Flower, "flower-2": Flower2, rose: Rose, clover: Clover, "tree-pine": TreePine,
  "tree-deciduous": TreeDeciduous, "tree-palm": TreePalm, trees: Trees, shrub: Shrub, mountain: Mountain, "mountain-snow": MountainSnow, sun: Sun,
  sunrise: Sunrise, sunset: Sunset, moon: Moon, "moon-star": MoonStar, cloud: Cloud, "cloud-sun": CloudSun, "cloud-lightning": CloudLightning,
  snowflake: Snowflake, droplet: Droplet, flame: Flame, wind: Wind, tornado: Tornado, rainbow: Rainbow, earth: Earth, globe: Globe, eclipse: Eclipse,
  galaxy: Galaxy, haze: Haze, umbrella: Umbrella, stone: Stone,
  // Food & drink
  coffee: Coffee, "cup-soda": CupSoda, beer: Beer, wine: Wine, martini: Martini, milk: Milk, apple: Apple, banana: Banana, cherry: Cherry,
  grape: Grape, citrus: Citrus, carrot: Carrot, broccoli: Broccoli, avocado: Avocado, pizza: Pizza, sandwich: Sandwich, hamburger: Hamburger,
  croissant: Croissant, cookie: Cookie, cake: Cake, "cake-slice": CakeSlice, cupcake: Cupcake, donut: Donut, dessert: Dessert,
  "ice-cream-cone": IceCreamCone, popcorn: Popcorn, popsicle: Popsicle, lollipop: Lollipop, candy: Candy, "candy-cane": CandyCane, soup: Soup,
  salad: Salad, beef: Beef, ham: Ham, drumstick: Drumstick, bacon: Bacon, wheat: Wheat, bean: Bean, nut: Nut, "cooking-pot": CookingPot,
  utensils: Utensils,
  // Tools & making
  hammer: Hammer, wrench: Wrench, drill: Drill, axe: Axe, shovel: Shovel, pickaxe: Pickaxe, anvil: Anvil, toolbox: Toolbox, "tool-case": ToolCase,
  ruler: Ruler, scissors: Scissors, paintbrush: Paintbrush, palette: Palette, "paint-bucket": PaintBucket, "paint-roller": PaintRoller, brush: Brush,
  pencil: Pencil, "pen-tool": PenTool, highlighter: Highlighter, eraser: Eraser, magnet: Magnet, construction: Construction, cog: Cog, bolt: Bolt,
  screw: Screw, key: Key, lock: Lock, flashlight: Flashlight, lamp: Lamp, lightbulb: Lightbulb, plug: Plug, spool: Spool, scale: Scale, gavel: Gavel,
  hourglass: Hourglass, broom: Broom, "flask-conical": FlaskConical, beaker: Beaker, microscope: Microscope, "test-tube": TestTube,
  // Tech & code
  terminal: Terminal, code: Code, braces: Braces, brackets: Brackets, database: Database, server: Server, laptop: Laptop, computer: Computer,
  monitor: Monitor, smartphone: Smartphone, keyboard: Keyboard, mouse: Mouse, webcam: Webcam, headphones: Headphones, headset: Headset, mic: Mic,
  radio: Radio, tv: Tv, printer: Printer, "hard-drive": HardDrive, usb: Usb, wifi: Wifi, bluetooth: Bluetooth, "git-branch": GitBranch,
  "git-merge": GitMerge, "git-pull-request": GitPullRequest, "git-commit-horizontal": GitCommitHorizontal, blocks: Blocks, boxes: Boxes, box: Box,
  package: Package, container: Container, layers: Layers, component: Component, shapes: Shapes, "qr-code": QrCode,
  "fingerprint-pattern": FingerprintPattern,
  // Places & travel
  house: House, building: Building, "building-complex": BuildingComplex, factory: Factory, warehouse: Warehouse, store: Store, school: School,
  university: University, landmark: Landmark, castle: Castle, church: Church, hospital: Hospital, hotel: Hotel, tent: Tent, "tent-tree": TentTree,
  "ferris-wheel": FerrisWheel, "roller-coaster": RollerCoaster, bridge: Bridge, dam: Dam, "map-pin": MapPin, plane: Plane, rocket: Rocket, car: Car,
  bus: Bus, "train-front": TrainFront, "tram-front": TramFront, bike: Bike, motorbike: Motorbike, scooter: Scooter, truck: Truck, tractor: Tractor,
  forklift: Forklift, helicopter: Helicopter, drone: Drone, "cable-car": CableCar, caravan: Caravan, fuel: Fuel, "traffic-cone": TrafficCone,
  signpost: Signpost, milestone: Milestone, route: Route, luggage: Luggage, backpack: Backpack, "tickets-plane": TicketsPlane,
  "tower-control": TowerControl,
  // Games & fun
  "dice-5": Dice5, dices: Dices, "gamepad-2": Gamepad2, gamepad: Gamepad, joystick: Joystick, puzzle: Puzzle, "toy-brick": ToyBrick,
  "party-popper": PartyPopper, gift: Gift, balloon: Balloon, guitar: Guitar, "guitar-electric": GuitarElectric, drum: Drum, piano: Piano,
  "eighth-notes": EighthNotes, film: Film, clapperboard: Clapperboard, camera: Camera, "tic-tac-toe": TicTacToe, spade: Spade, club: Club,
  volleyball: Volleyball, "rugby-ball": RugbyBall, dumbbell: Dumbbell, sword: Sword, swords: Swords, "bow-arrow": BowArrow, wand: Wand, bomb: Bomb,
  origami: Origami, metronome: Metronome, "cassette-tape": CassetteTape, "disc-3": Disc3, turntable: Turntable,
  // Symbols
  zap: Zap, sparkle: Sparkle, asterisk: Asterisk, hash: Hash, "at-sign": AtSign, ampersand: Ampersand, circle: Circle, square: Square,
  triangle: Triangle, hexagon: Hexagon, octagon: Octagon, pentagon: Pentagon, diamond: Diamond, squircle: Squircle, cross: Cross, plus: Plus,
  check: Check, recycle: Recycle, radiation: Radiation, biohazard: Biohazard, target: Target, crosshair: Crosshair, focus: Focus,
  "heart-pulse": HeartPulse, activity: Activity, omega: Omega, pi: Pi, "zodiac-aries": ZodiacAries, "zodiac-taurus": ZodiacTaurus,
  "zodiac-gemini": ZodiacGemini, "zodiac-cancer": ZodiacCancer, "zodiac-leo": ZodiacLeo, "zodiac-virgo": ZodiacVirgo, "zodiac-libra": ZodiacLibra,
  "zodiac-scorpio": ZodiacScorpio, "zodiac-sagittarius": ZodiacSagittarius, "zodiac-capricorn": ZodiacCapricorn, "zodiac-aquarius": ZodiacAquarius,
  "zodiac-pisces": ZodiacPisces,
  // Work & things
  briefcase: Briefcase, inbox: Inbox, archive: Archive, folder: Folder, file: FileIcon, notebook: Notebook, book: Book, library: Library,
  newspaper: Newspaper, clipboard: Clipboard, calendar: Calendar, clock: Clock, "alarm-clock": AlarmClock, timer: Timer, watch: Watch, mail: Mail,
  send: Send, phone: Phone, "message-circle": MessageCircle, bell: Bell, bookmark: Bookmark, tag: Tag, wallet: Wallet, "credit-card": CreditCard,
  coins: Coins, banknote: Banknote, "piggy-bank": PiggyBank, receipt: Receipt, "shopping-cart": ShoppingCart, "shopping-bag": ShoppingBag,
  "chart-column": ChartColumn, "trending-up": TrendingUp, gauge: Gauge, presentation: Presentation, kanban: Kanban, calculator: Calculator,
  "sticky-note": StickyNote, lectern: Lectern,
}
