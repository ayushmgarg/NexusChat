# NexusChat

A lightweight internal real-time messaging platform with role-based access control, built for engineering organizations that need a controlled, self-hosted communication environment.

![NexusChat](https://img.shields.io/badge/NexusChat-v1.0.0-00e5a0?style=for-the-badge)
![Node.js](https://img.shields.io/badge/Node.js-20-339933?style=for-the-badge&logo=nodedotjs)
![Socket.IO](https://img.shields.io/badge/Socket.IO-4.7-010101?style=for-the-badge&logo=socketdotio)
![Supabase](https://img.shields.io/badge/Supabase-PostgreSQL-3ECF8E?style=for-the-badge&logo=supabase)
![License](https://img.shields.io/badge/License-MIT-blue?style=for-the-badge)

---

## Live Demo

🟢 **[https://ayushg10-nexuschat.hf.space](https://ayushg10-nexuschat.hf.space)**

> Login with a registered account or contact the admin for an invite code.

---

## What is NexusChat

NexusChat is a controlled internal messaging system where not everyone holds equal power. It has a strict role hierarchy, invite-only registration support, real-time messaging across multiple channels, slash commands, typing indicators, and online presence tracking — all in a single deployable Node.js app with no external dependencies beyond a PostgreSQL database.

---

## Features

- Real-time messaging via WebSockets (Socket.IO)
- Three-tier role system: `superadmin`, `moderator`, `member`
- Multi-room channel support
- Slash command system (extensible)
- Typing indicators and online presence
- Invite code system with shareable links
- JWT authentication with HTTP-only cookies
- Persistent message history via Supabase PostgreSQL
- Single-file frontend — no build step, no bundler
- Docker support for one-command deployment
- Deployed on Hugging Face Spaces (free, always on)

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20 |
| Framework | Express.js |
| Real-time | Socket.IO 4 |
| Database | Supabase (PostgreSQL) |
| Auth | JWT + bcrypt |
| Frontend | Vanilla HTML/CSS/JS (single file) |
| Deployment | Hugging Face Spaces (Docker) |

---

## Project Structure
```
nexuschat/
├── src/
│   ├── server.js      # Entry point — Express + Socket.IO
│   ├── db.js          # Supabase PostgreSQL client and schema
│   ├── auth.js        # JWT helpers, Express and Socket middleware
│   ├── routes.js      # REST API endpoints
│   ├── socket.js      # Real-time event handlers
│   ├── commands.js    # Slash command parser and executor
│   └── seed.js        # Database seeder
├── public/
│   └── index.html     # Complete single-file SPA frontend
├── data/              # Local SQLite fallback (auto-created)
├── .env.example       # Environment variable template
├── Dockerfile         # Container definition
├── docker-compose.yml # Local Docker Compose setup
└── package.json
```

---

## Role System

| Capability | member | moderator | superadmin |
|---|:---:|:---:|:---:|
| Send messages | yes | yes | yes |
| Join rooms | yes | yes | yes |
| Create rooms | | yes | yes |
| Kick users | | yes | yes |
| Update room topic | | yes | yes |
| Delete rooms | | | yes |
| Promote / demote users | | | yes |
| Generate invite codes | | | yes |

---

## Slash Commands

| Command | Role Required | Description |
|---|:---:|---|
| `/help` | member | List all commands |
| `/rooms` | member | List all rooms |
| `/who` | member | List members in current room |
| `/kick <username>` | moderator | Remove user from room |
| `/promote <username> <role>` | superadmin | Change a user's role |
| `/createroom <name> [desc]` | moderator | Create a new room |
| `/deleteroom <name>` | superadmin | Delete a room |
| `/topic <text>` | moderator | Update room description |

---

## REST API

All endpoints are prefixed with `/api`.

### Authentication

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/auth/register` | | Register a new account |
| POST | `/auth/login` | | Log in |
| POST | `/auth/logout` | | Log out |
| GET | `/auth/me` | yes | Get current user |
| GET | `/auth/invite/:code` | | Validate an invite code |

### Rooms

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/rooms` | yes | List all rooms |
| POST | `/rooms` | moderator | Create a room |
| DELETE | `/rooms/:id` | superadmin | Delete a room |
| POST | `/rooms/:id/join` | yes | Join a room |
| GET | `/rooms/:id/messages` | yes | Get message history |
| GET | `/rooms/:id/members` | yes | Get room members |

### Invites

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/invites` | superadmin | List all invite codes |
| POST | `/invites` | superadmin | Generate invite code |
| DELETE | `/invites/:code` | superadmin | Delete invite code |

### Users

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/users` | moderator | List all users |
| PATCH | `/users/:id/role` | superadmin | Change a user's role |

---

## Socket.IO Events

### Client to Server

| Event | Payload | Description |
|---|---|---|
| `room:join` | `{ roomId }` | Join a room and receive history |
| `room:leave` | `{ roomId }` | Leave a room |
| `message:send` | `{ roomId, content }` | Send a message or command |
| `typing:start` | `{ roomId }` | Notify typing started |
| `typing:stop` | `{ roomId }` | Notify typing stopped |

### Server to Client

| Event | Payload | Description |
|---|---|---|
| `message:new` | message object | New message in room |
| `users:online` | `{ userIds }` | Updated online user list |
| `typing:update` | `{ userId, username, typing }` | Typing status change |
| `kicked` | `{ roomId, by }` | You were removed from a room |
| `room:created` | room object | A new room was created |
| `room:deleted` | `{ id }` | A room was deleted |
| `room:topicUpdated` | `{ roomId, description }` | Room topic changed |

---

## Local Setup

### Requirements

- Node.js 20+
- A Supabase account (free) or local SQLite fallback

### Steps
```bash
# 1. Clone the repo
git clone https://github.com/ayushg10/nexuschat.git
cd nexuschat

# 2. Install dependencies
npm install

# 3. Create .env file
# On Windows PowerShell:
$content = @"
PORT=3000
JWT_SECRET=your-secret-here
DATABASE_URL=postgresql://...your-supabase-url...
SUPERADMIN_USERNAME=admin
SUPERADMIN_PASSWORD=yourpassword
REQUIRE_INVITE=false
CORS_ORIGIN=*
"@
[System.IO.File]::WriteAllText("$PWD\.env", $content, [System.Text.UTF8Encoding]::new($false))

# 4. Seed the database
npm run seed

# 5. Start the server
npm start
```

Open `http://localhost:3000` and log in with your admin credentials.

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `JWT_SECRET` | yes | Secret for signing JWT tokens — use a long random string |
| `DATABASE_URL` | yes | Supabase PostgreSQL connection string |
| `PORT` | no | Server port (default: 3000) |
| `SUPERADMIN_USERNAME` | no | Admin username (default: admin) |
| `SUPERADMIN_PASSWORD` | no | Admin password (default: Admin@12345) |
| `REQUIRE_INVITE` | no | Set to `true` to require invite codes to register |
| `CORS_ORIGIN` | no | Allowed CORS origin (default: *) |

Generate a secure JWT secret:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Deployment

### Hugging Face Spaces (current — free, always on)

1. Fork this repository
2. Create a new Space at `https://huggingface.co/new-space`
3. Select **Docker** as the SDK
4. Go to Space **Settings** → **Repository secrets** and add all environment variables
5. Push your code to the Space:
```bash
git remote add hf https://YOUR_USERNAME:YOUR_HF_TOKEN@huggingface.co/spaces/YOUR_USERNAME/nexuschat
git push hf main
```

### Docker (self-hosted)
```bash
docker compose up -d
```

### Cloudflare Tunnel (quick public access from local machine)
```bash
# Start your server
npm start

# In a second terminal
cloudflared tunnel --url http://localhost:3000
```

---

## Security

- Passwords hashed with bcrypt (cost factor 12)
- JWTs stored as HTTP-only, SameSite=Lax cookies
- Per-IP rate limiting on auth endpoints (15 requests/minute)
- All inputs validated server-side before hitting the database
- Parameterized queries throughout — no SQL injection surface
- Security headers on every response: `X-Content-Type-Options`, `X-Frame-Options`, `X-XSS-Protection`
- Non-root user in Docker container
- Environment variables never committed to version control

---

## Adding a New Slash Command

Open `src/commands.js` and add an entry to the `COMMANDS` object:
```js
mycommand: {
  description: 'What this command does',
  minRole: 'moderator',
  async handler({ user, args, roomId, io }) {
    // your logic here
    return {
      success: true,
      systemMessage: 'Output shown to room',
      broadcast: false, // true = whole room sees it
    };
  },
},
```

No other files need to change. The command is automatically listed in `/help`.

---

## License

MIT
