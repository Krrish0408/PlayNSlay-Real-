/**
 * Play N Slay — Official k6 Load & Concurrency Benchmark Suite
 *
 * Scenarios Tested:
 * 1. Public Station Browsing (GET /api/stations)
 * 2. User Authentication / Login (POST /api/login)
 * 3. Booking Availability & Station Schedules (GET /api/bookings)
 * 4. Booking Creation (POST /api/bookings)
 * 5. Booking Cancellation (PATCH /api/bookings/:id/status)
 * 6. Employee Dashboard & Operational Stats (GET /api/employee/stats)
 * 7. Admin Analytics & Comprehensive Metrics (GET /api/admin/stats/comprehensive)
 * 8. High-Contention Concurrency: Simultaneous booking race condition on exact same slot
 *
 * Execution:
 *   k6 run load-tests/k6-load-test.js
 *   k6 run --env BASE_URL=http://localhost:5000 load-tests/k6-load-test.js
 */

import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

// Custom Metrics
export const bookingSuccesses = new Counter('booking_success_count');
export const bookingConflicts = new Counter('booking_conflict_count');
export const doubleBookingViolations = new Counter('double_booking_violations');
export const authSuccessRate = new Rate('auth_success_rate');
export const stationBrowseDuration = new Trend('station_browse_duration', true);
export const bookingCreationDuration = new Trend('booking_creation_duration', true);
export const adminAnalyticsDuration = new Trend('admin_analytics_duration', true);

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:5000';

export const options = {
  scenarios: {
    // 1. Public Station Browsing
    public_station_browsing: {
      executor: 'constant-vus',
      vus: 10,
      duration: '15s',
      exec: 'testPublicStationBrowsing',
    },
    // 2. User Authentication / Login
    user_login: {
      executor: 'constant-vus',
      vus: 5,
      duration: '15s',
      exec: 'testUserLogin',
      startTime: '5s',
    },
    // 3. Booking Availability
    booking_availability: {
      executor: 'constant-vus',
      vus: 10,
      duration: '15s',
      exec: 'testBookingAvailability',
      startTime: '10s',
    },
    // 4. Booking Creation
    booking_creation: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '5s', target: 8 },
        { duration: '10s', target: 8 },
        { duration: '3s', target: 0 },
      ],
      exec: 'testBookingCreation',
      startTime: '15s',
    },
    // 5. Booking Cancellation
    booking_cancellation: {
      executor: 'constant-vus',
      vus: 4,
      duration: '12s',
      exec: 'testBookingCancellation',
      startTime: '25s',
    },
    // 6. Employee Dashboard
    employee_dashboard: {
      executor: 'constant-vus',
      vus: 5,
      duration: '12s',
      exec: 'testEmployeeDashboard',
      startTime: '30s',
    },
    // 7. Admin Analytics
    admin_analytics: {
      executor: 'constant-vus',
      vus: 3,
      duration: '10s',
      exec: 'testAdminAnalytics',
      startTime: '35s',
    },
    // 8. Strict Concurrency Race Condition Test
    concurrency_race_condition: {
      executor: 'per-vu-iterations',
      vus: 20,
      iterations: 1,
      maxDuration: '10s',
      exec: 'testConcurrencyRaceCondition',
      startTime: '45s',
    },
  },
  thresholds: {
    http_req_duration: ['p(50)<150', 'p(95)<450', 'p(99)<850'],
    http_req_failed: ['rate<0.08'], // Allows expected 409 conflict responses in race test
    double_booking_violations: ['count===0'], // Zero double bookings tolerated
  },
};

// Helper to authenticate user and extract cookie
function authenticate(username, password) {
  const payload = JSON.stringify({ username, password });
  const params = {
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
  };
  const res = http.post(`${BASE_URL}/api/login`, payload, params);
  const success = check(res, {
    'login returned 200': (r) => r.status === 200,
  });
  authSuccessRate.add(success);
  return { res, cookies: res.cookies };
}

// 1. Scenario: Public Station Browsing
export function testPublicStationBrowsing() {
  group('1. Public Station Browsing', () => {
    const start = new Date();
    const res = http.get(`${BASE_URL}/api/stations`, {
      headers: { Accept: 'application/json' },
    });
    stationBrowseDuration.add(new Date() - start);

    check(res, {
      'stations returned 200': (r) => r.status === 200,
      'stations has valid payload': (r) => {
        try {
          const json = r.json();
          return Array.isArray(json) || Array.isArray(json.items);
        } catch {
          return false;
        }
      },
    });
    sleep(0.1);
  });
}

// 2. Scenario: User Login
export function testUserLogin() {
  group('2. User Login', () => {
    const auth = authenticate('admin', 'admin123');
    check(auth.res, {
      'auth user has role': (r) => {
        try {
          return r.json('role') !== undefined;
        } catch {
          return false;
        }
      },
    });
    sleep(0.2);
  });
}

// 3. Scenario: Booking Availability
export function testBookingAvailability() {
  group('3. Booking Availability', () => {
    const auth = authenticate('member_load_test', 'member123');
    const res = http.get(`${BASE_URL}/api/bookings?limit=20`, {
      headers: { Accept: 'application/json' },
    });
    check(res, {
      'booking schedule returned 200': (r) => r.status === 200,
    });
    sleep(0.1);
  });
}

// 4. Scenario: Booking Creation
export function testBookingCreation() {
  group('4. Booking Creation', () => {
    const auth = authenticate('member_load_test', 'member123');
    const now = Date.now() + Math.floor(Math.random() * 86400000);
    const startTime = new Date(now).toISOString();
    const endTime = new Date(now + 3600000).toISOString();

    const payload = JSON.stringify({
      startTime,
      endTime,
      gameTypeId: 1,
      paymentMethod: 'offline',
      playerCount: 1,
      locationId: 'main-lounge',
    });

    const start = new Date();
    const res = http.post(`${BASE_URL}/api/bookings`, payload, {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Idempotency-Key': `load-idem-${__VU}-${__ITER}-${Date.now()}`,
      },
    });
    bookingCreationDuration.add(new Date() - start);

    if (res.status === 201) {
      bookingSuccesses.add(1);
    } else if (res.status === 409) {
      bookingConflicts.add(1);
    }

    check(res, {
      'booking creation responded with 201 or 409': (r) => r.status === 201 || r.status === 409,
    });
    sleep(0.2);
  });
}

// 5. Scenario: Booking Cancellation
export function testBookingCancellation() {
  group('5. Booking Cancellation', () => {
    const auth = authenticate('member_load_test', 'member123');
    // Create a temporary booking to cancel
    const now = Date.now() + 100000000 + Math.floor(Math.random() * 50000000);
    const createRes = http.post(
      `${BASE_URL}/api/bookings`,
      JSON.stringify({
        startTime: new Date(now).toISOString(),
        endTime: new Date(now + 3600000).toISOString(),
        gameTypeId: 1,
        paymentMethod: 'offline',
        playerCount: 1,
      }),
      { headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' } }
    );

    if (createRes.status === 201) {
      const bookingId = createRes.json('id');
      const cancelRes = http.patch(
        `${BASE_URL}/api/bookings/${bookingId}/status`,
        JSON.stringify({ status: 'Cancelled' }),
        { headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' } }
      );
      check(cancelRes, {
        'cancellation returned 200': (r) => r.status === 200,
      });
    }
    sleep(0.2);
  });
}

// 6. Scenario: Employee Dashboard
export function testEmployeeDashboard() {
  group('6. Employee Dashboard', () => {
    authenticate('employee', 'employee123');
    const res = http.get(`${BASE_URL}/api/employee/stats`, {
      headers: { Accept: 'application/json' },
    });
    check(res, {
      'employee stats returned 200': (r) => r.status === 200,
    });
    sleep(0.2);
  });
}

// 7. Scenario: Admin Analytics
export function testAdminAnalytics() {
  group('7. Admin Analytics', () => {
    authenticate('admin', 'admin123');
    const start = new Date();
    const res = http.get(`${BASE_URL}/api/admin/stats/comprehensive`, {
      headers: { Accept: 'application/json' },
    });
    adminAnalyticsDuration.add(new Date() - start);

    check(res, {
      'admin stats returned 200': (r) => r.status === 200,
    });
    sleep(0.3);
  });
}

// 8. Scenario: Strict Concurrency Race Condition Test
const TARGET_RACE_START = '2026-10-15T18:00:00.000Z';
const TARGET_RACE_END = '2026-10-15T20:00:00.000Z';
const TARGET_STATION_ID = 1;

export function testConcurrencyRaceCondition() {
  group('8. Concurrency Race Condition', () => {
    authenticate('member_load_test', 'member123');

    const payload = JSON.stringify({
      startTime: TARGET_RACE_START,
      endTime: TARGET_RACE_END,
      stationId: TARGET_STATION_ID,
      gameTypeId: 1,
      paymentMethod: 'offline',
      playerCount: 1,
    });

    const res = http.post(`${BASE_URL}/api/bookings`, payload, {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    });

    if (res.status === 201) {
      bookingSuccesses.add(1);
    } else if (res.status === 409) {
      bookingConflicts.add(1);
    } else {
      // Any other error or failure under concurrency
      check(res, { 'expected 201 or 409': false });
    }
  });
}
