# Project Improvements - 10/10 Roadmap

## Phase 1: Critical Fixes (Week 1-2)

### 1.1 Add Pagination to All Endpoints
```js
// server.js - Add to all GET collection endpoints
app.get("/deliveries", async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
  const offset = parseInt(req.query.offset) || 0;
  // Use Firestore query with limit/offset handled client-side due to Firestore limitations
  // OR add startAfter for cursor-based pagination
});

app.get("/service/tickets", async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
  const cursor = req.query.cursor; // Last document ID for cursor-based pagination
});
```

### 1.2 Add Input Sanitization
```js
// Create middleware/sanitizer.js
export function sanitizeInput(input) {
  if (typeof input !== 'string') return input;
  return input
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;')
    .trim();
}

export function sanitizeObject(obj) {
  const sanitized = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      sanitized[key] = sanitizeInput(value);
    } else if (typeof value === 'object') {
      sanitized[key] = sanitizeObject(value);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}
```

### 1.3 Add Error Handling Middleware
```js
// server.js - Add at the end, before listen
app.use((err, req, res, next) => {
  console.error('📛 Error:', err.stack);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' 
      ? 'Internal server error' 
      : err.message
  });
});
```

### 1.4 Add Request Logging
```js
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`📝 ${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
    // Optionally log to Firestore for analytics
  });
  next();
});
```

---

## Phase 2: Performance (Week 2-3)

### 2.1 Add Response Compression
```bash
npm install compression
```
```js
import compression from 'compression';
app.use(compression());
```

### 2.2 Add Firestore Composite Indexes
Create file `firestore.indexes.json`:
```json
{
  "indexes": [
    {
      "collectionGroup": "deliveries",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "status", "order": "ASC" },
        { "fieldPath": "assigned_driver_id", "order": "ASC" }
      ]
    },
    {
      "collectionGroup": "deliveries",
      "queryScope": "COLLECTION", 
      "fields": [
        { "fieldPath": "status", "order": "ASC" },
        { "fieldPath": "created_timestamp", "order": "DESC" }
      ]
    },
    {
      "collectionGroup": "service_tickets",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "status", "order": "ASC" },
        { "fieldPath": "created_at", "order": "DESC" }
      ]
    }
  ]
}
```

### 2.3 Add Response Caching
```js
app.get("/products", (req, res) => {
  res.set('Cache-Control', 'public, max-age=300'); // 5 min cache
});
```

### 2.4 Add Rate Limiting Per-User
```js
import rateLimit from 'express-rate-limit';

const userLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100, // per user
  keyGenerator: (req) => req.user?.id || req.ip
});
```

---

## Phase 3: Code Quality (Week 3-4)

### 3.1 Split server.js into Modules
```
server/
├── index.js          # Entry point
├── routes/
│   ├── deliveries.js
│   ├── drivers.js
│   ├── inventory.js
│   ├── service.js
│   ├── leads.js
│   ├── tally.js
│   └── auth.js
├── middleware/
│   ├── auth.js
│   ├── rateLimit.js
│   └── sanitize.js
├── services/
│   ├── firestore.js
│   ├── storage.js
│   └── notification.js
└── utils/
    ├── date.js
    └── validate.js
```

### 3.2 Add TypeScript
```bash
npm install -D typescript @types/node @types/express
npx tsc --init
```

### 3.3 Add JSDoc Comments
```js
/**
 * Creates a new delivery
 * @param {Object} data - Delivery data
 * @param {string} data.customer_name - Customer name
 * @param {string} data.phone - Phone number (10 digits)
 * @param {string} data.product_name - Product name
 * @param {string} data.estimated_delivery_time - ISO datetime
 * @returns {Promise<{id: string}>} Created delivery ID
 */
async function createDelivery(data) { }
```

---

## Phase 4: Frontend Improvements (Week 4-5)

### 4.1 Add Global Error Toast
```js
// frontend - Add to all fetch calls
async function apiCall(url, options) {
  try {
    const res = await fetch(url, options);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    showToast(err.message, 'error');
    throw err;
  }
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}
```

### 4.2 Add Loading States
```js
function setLoading(loading) {
  document.querySelectorAll('button, input').forEach(el => {
    el.disabled = loading;
    el.classList.toggle('loading', loading);
  });
}
```

### 4.3 Add Pagination UI
```html
<div class="pagination">
  <button onclick="prevPage()">Previous</button>
  <span>Page <span id="page">1</span></span>
  <button onclick="nextPage()">Next</button>
</div>
```

### 4.4 Add Batch Delete
```js
async function bulkDelete(ids) {
  if (!confirm(`Delete ${ids.length} items?`)) return;
  await Promise.all(ids.map(id => apiCall(`/delivery/${id}`, { method: 'DELETE' })));
  refresh();
}
```

---

## Phase 5: Testing (Week 5-6)

### 5.1 Add Unit Tests
```bash
npm install -D vitest
```
```js
// tests/sanitize.test.js
import { describe, it, expect } from 'vitest';
import { sanitizeInput } from '../middleware/sanitize.js';

describe('sanitizeInput', () => {
  it('removes script tags', () => {
    expect(sanitizeInput('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});
```

### 5.2 Add API Integration Tests
```js
// tests/api.test.js
import { test, expect } from 'vitest';

test('GET /health returns 200', async () => {
  const res = await fetch('http://localhost:5000/health');
  expect(res.status).toBe(200);
});
```

### 5.3 Add Load Tests
```bash
npm install -D autocannon
```
```js
// tests/load.js
import autocannon from 'autocannon';

const result = await autocannon({
  url: 'http://localhost:5000/health',
  connections: 10,
  duration: 10
});
console.log(result);
```

---

## Phase 6: DevOps (Week 6-7)

### 6.1 Add CI/CD
```yaml
# .github/workflows/test.yml
name: Test
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - run: npm install
      - run: npm test

# .github/workflows/deploy.yml
name: Deploy
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - run: npm install
      - run: npm run build
```

### 6.2 Add Health Check Endpoint
```js
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});
```

### 6.3 Add Metrics
```js
app.get('/metrics', async (req, res) => {
  const deliveries = await getDocs(collection(db, 'deliveries'));
  res.json({
    totalDeliveries: deliveries.size,
    pending: deliveries.docs.filter(d => d.data().status === 'pending').length,
    delivered: deliveries.docs.filter(d => d.data().status === 'delivered').length
  });
});
```

---

## Phase 7: Security (Week 7-8)

### 7.1 Add Helmet
```bash
npm install helmet
```
```js
import helmet from 'helmet';
app.use(helmet());
```

### 7.2 Add CORS Validation
```js
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || [],
  credentials: true
}));
```

### 7.3 Add Rate Limit by Role
```js
const roleLimits = {
  admin: 1000,
  accountant: 500,
  staff: 200,
  driver: 100,
  service: 200
};
```

### 7.4 Audit Logging
```js
async function logAudit(action, user, data) {
  await addDoc(collection(db, 'audit_log'), {
    action, user, data, timestamp: Timestamp.now()
  });
}
```

---

## Phase 8: Documentation (Week 8)

### 8.1 Add README
```markdown
# Hariom Delivery Management System

## API Endpoints

### Deliveries
- `GET /deliveries` - List deliveries
- `POST /createDelivery` - Create delivery

## Deployment
See DEPLOY.md for deployment instructions.
```

### 8.2 Add API Documentation
```bash
npm install -D swagger-ui-express
```
```js
import swaggerUi from 'swagger-ui-express';
import specs from './swagger.js';

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(specs));
```

### 8.3 Add Postman Collection
Export API endpoints to Postman collection format.

---

## Summary Checklist

| Phase | Task | Effort |
|-------|------|--------|
| 1 | Pagination | Medium |
| 1 | Input Sanitization | Low |
| 1 | Error Handling | Low |
| 1 | Request Logging | Low |
| 2 | Compression | Low |
| 2 | Firestore Indexes | Medium |
| 2 | Rate Limiting | Low |
| 3 | Split server.js | High |
| 3 | TypeScript | High |
| 4 | Frontend Error Handling | Medium |
| 4 | Pagination UI | Low |
| 5 | Unit Tests | Medium |
| 5 | Load Tests | Low |
| 6 | CI/CD | Medium |
| 6 | Health Check | Low |
| 7 | Helmet | Low |
| 7 | Audit Logging | Medium |
| 8 | README | Low |
| 8 | API Docs | Medium |

## Estimated Timeline
- Phase 1: Week 1-2
- Phase 2: Week 2-3
- Phase 3: Week 3-4
- Phase 4: Week 4-5
- Phase 5: Week 5-6
- Phase 6: Week 6-7
- Phase 7: Week 7-8
- Phase 8: Week 8

**Total: ~8 weeks to 10/10**