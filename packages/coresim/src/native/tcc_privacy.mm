#include "tcc_privacy.h"

#include <sqlite3.h>

#include <cstring>
#include <string>

namespace coresim {

namespace {

NSString* const kTCCErrorDomain = @"io.appium.coresim.TCCPrivacy";

NSError* MakeError(int code, NSString* message) {
  return [NSError errorWithDomain:kTCCErrorDomain code:code userInfo:@{NSLocalizedDescriptionKey : message}];
}

NSString* TCCDatabasePath(NSString* dataPath) {
  return [dataPath stringByAppendingPathComponent:@"Library/TCC/TCC.db"];
}

// SQLITE_OPEN_READWRITE only (no _CREATE): fails with SQLITE_CANTOPEN instead of silently
// creating an empty, schema-less database when the simulator has never been booted.
sqlite3* OpenDatabase(NSString* dataPath, NSError** error) {
  NSString* path = TCCDatabasePath(dataPath);
  sqlite3* db = nullptr;
  int rc = sqlite3_open_v2(path.UTF8String, &db, SQLITE_OPEN_READWRITE, nullptr);
  if (rc != SQLITE_OK) {
    if (error) {
      *error = MakeError(rc, [NSString stringWithFormat:@"Could not open TCC database at '%@' — the device may "
                                                        @"need to be booted at least once first: %s",
                                                        path, sqlite3_errstr(rc)]);
    }
    if (db) {
      sqlite3_close(db);
    }
    return nullptr;
  }
  // Waits (rather than immediately failing) if the simulator's own tccd process has the database
  // locked, instead of a manual sleep/retry loop.
  sqlite3_busy_timeout(db, 5000);
  return db;
}

// TCC schema gained `auth_value` (replacing the older boolean `allowed` column) in iOS 14; checked
// against the actual database rather than an OS version threshold, since the schema version tracks
// the *simulator's* iOS release, not the host's.
bool HasAuthValueColumn(sqlite3* db) {
  sqlite3_stmt* stmt = nullptr;
  if (sqlite3_prepare_v2(db, "PRAGMA table_info(access)", -1, &stmt, nullptr) != SQLITE_OK) {
    return false;
  }
  bool found = false;
  while (sqlite3_step(stmt) == SQLITE_ROW) {
    const unsigned char* name = sqlite3_column_text(stmt, 1);
    if (name && std::strcmp(reinterpret_cast<const char*>(name), "auth_value") == 0) {
      found = true;
      break;
    }
  }
  sqlite3_finalize(stmt);
  return found;
}

void BindText(sqlite3_stmt* stmt, int index, NSString* value) {
  sqlite3_bind_text(stmt, index, value.UTF8String, -1, SQLITE_TRANSIENT);
}

// Runs one parameterized statement to completion. `bind` receives the prepared statement to bind
// its own parameters onto.
template <typename BindFn>
bool ExecuteStatement(sqlite3* db, const char* sql, BindFn bind, NSError** error) {
  sqlite3_stmt* stmt = nullptr;
  if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK) {
    if (error) {
      *error =
          MakeError(sqlite3_errcode(db),
                    [NSString stringWithFormat:@"Failed to prepare TCC database statement: %s", sqlite3_errmsg(db)]);
    }
    return false;
  }
  bind(stmt);
  int rc = sqlite3_step(stmt);
  sqlite3_finalize(stmt);
  if (rc != SQLITE_DONE) {
    if (error) {
      *error = MakeError(rc, [NSString stringWithFormat:@"Failed to update TCC database: %s", sqlite3_errmsg(db)]);
    }
    return false;
  }
  return true;
}

bool DeleteAccessRow(sqlite3* db, NSString* service, NSString* bundleId, NSError** error) {
  return ExecuteStatement(
      db, "DELETE FROM access WHERE service = ? AND client = ? AND client_type = 0",
      [&](sqlite3_stmt* stmt) {
        BindText(stmt, 1, service);
        BindText(stmt, 2, bundleId);
      },
      error);
}

// The delete+insert pair below must not be allowed to commit independently — a failure between
// them would otherwise permanently drop the prior row instead of leaving it unchanged.
bool BeginTransaction(sqlite3* db, NSError** error) {
  if (sqlite3_exec(db, "BEGIN IMMEDIATE TRANSACTION", nullptr, nullptr, nullptr) == SQLITE_OK) {
    return true;
  }
  if (error) {
    *error = MakeError(sqlite3_errcode(db),
                       [NSString stringWithFormat:@"Failed to begin TCC database transaction: %s", sqlite3_errmsg(db)]);
  }
  return false;
}

// Returns whether the transaction actually ended up committed. On a COMMIT failure (e.g.
// SQLITE_BUSY from a concurrent reader — SQLite documents that a busy COMMIT leaves the
// transaction still active, not rolled back automatically) the transaction is explicitly rolled
// back here rather than left for sqlite3_close to implicitly discard, so the caller gets an
// accurate failure instead of the `true` that the statements before COMMIT itself had reported.
bool CommitOrRollback(sqlite3* db, bool commit, NSError** error) {
  if (commit) {
    if (sqlite3_exec(db, "COMMIT", nullptr, nullptr, nullptr) == SQLITE_OK) {
      return true;
    }
    if (error) {
      *error =
          MakeError(sqlite3_errcode(db),
                    [NSString stringWithFormat:@"Failed to commit TCC database transaction: %s", sqlite3_errmsg(db)]);
    }
  }
  sqlite3_exec(db, "ROLLBACK", nullptr, nullptr, nullptr);
  return false;
}

}  // namespace

BOOL SetTCCAccess(NSString* dataPath, NSString* service, NSString* bundleId, TCCAuthStatus desiredStatus,
                  NSError** error) {
  sqlite3* db = OpenDatabase(dataPath, error);
  if (!db) {
    return NO;
  }

  BOOL success = BeginTransaction(db, error);
  if (success) {
    success = DeleteAccessRow(db, service, bundleId, error);
  }
  if (success) {
    if (HasAuthValueColumn(db)) {
      // `kTCCServicePhotos` rows use auth_version 2 (supports the "limited" library access
      // introduced alongside it); every other service uses version 1.
      BOOL isPhotos = [service isEqualToString:@"kTCCServicePhotos"];
      int authValue = desiredStatus == kTCCAuthGranted ? 2 : desiredStatus == kTCCAuthLimited ? 3 : 0;
      success = ExecuteStatement(
          db,
          "INSERT INTO access (service, client, client_type, auth_value, auth_reason, auth_version, flags) "
          "VALUES (?, ?, 0, ?, 2, ?, 0)",
          [&](sqlite3_stmt* stmt) {
            BindText(stmt, 1, service);
            BindText(stmt, 2, bundleId);
            sqlite3_bind_int(stmt, 3, authValue);
            sqlite3_bind_int(stmt, 4, isPhotos ? 2 : 1);
          },
          error);
    } else {
      // Pre-iOS 14 schema has no auth_value column, so "limited" collapses to a plain grant here.
      BOOL allowed = desiredStatus != kTCCAuthDenied;
      success = ExecuteStatement(
          db, "REPLACE INTO access (service, client, client_type, allowed, prompt_count) VALUES (?, ?, 0, ?, 1)",
          [&](sqlite3_stmt* stmt) {
            BindText(stmt, 1, service);
            BindText(stmt, 2, bundleId);
            sqlite3_bind_int(stmt, 3, allowed ? 1 : 0);
          },
          error);
    }
  }

  success = CommitOrRollback(db, success, error);
  sqlite3_close(db);
  return success;
}

BOOL ResetTCCAccess(NSString* dataPath, NSString* service, NSString* bundleId, NSError** error) {
  sqlite3* db = OpenDatabase(dataPath, error);
  if (!db) {
    return NO;
  }
  BOOL success = DeleteAccessRow(db, service, bundleId, error);
  sqlite3_close(db);
  return success;
}

BOOL GetTCCAccess(NSString* dataPath, NSString* service, NSString* bundleId, TCCAuthStatus* outStatus,
                  NSError** error) {
  sqlite3* db = OpenDatabase(dataPath, error);
  if (!db) {
    return NO;
  }

  bool hasAuthValue = HasAuthValueColumn(db);
  const char* sql = hasAuthValue ? "SELECT auth_value FROM access WHERE service = ? AND client = ? AND client_type = 0"
                                 : "SELECT allowed FROM access WHERE service = ? AND client = ? AND client_type = 0";
  sqlite3_stmt* stmt = nullptr;
  if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK) {
    if (error) {
      *error =
          MakeError(sqlite3_errcode(db),
                    [NSString stringWithFormat:@"Failed to prepare TCC database statement: %s", sqlite3_errmsg(db)]);
    }
    sqlite3_close(db);
    return NO;
  }
  BindText(stmt, 1, service);
  BindText(stmt, 2, bundleId);

  BOOL success = YES;
  TCCAuthStatus status = kTCCAuthNotDetermined;
  int rc = sqlite3_step(stmt);
  if (rc == SQLITE_ROW) {
    int raw = sqlite3_column_int(stmt, 0);
    if (hasAuthValue) {
      // 0/2/3 per the schema comment in SetTCCAccess above; any other raw value (a reserved/future
      // one this addon doesn't know about) is reported as not-determined rather than guessed at.
      switch (raw) {
        case 0:
          status = kTCCAuthDenied;
          break;
        case 2:
          status = kTCCAuthGranted;
          break;
        case 3:
          status = kTCCAuthLimited;
          break;
        default:
          status = kTCCAuthNotDetermined;
          break;
      }
    } else {
      status = raw ? kTCCAuthGranted : kTCCAuthDenied;
    }
  } else if (rc != SQLITE_DONE) {
    success = NO;
    if (error) {
      *error = MakeError(rc, [NSString stringWithFormat:@"Failed to read TCC database: %s", sqlite3_errmsg(db)]);
    }
  }
  sqlite3_finalize(stmt);
  sqlite3_close(db);

  if (success && outStatus) {
    *outStatus = status;
  }
  return success;
}

}  // namespace coresim
