/**
 * data.js — Willow Tree Properties Time Tracking
 * Shared data module. Requires: supabase-config.js, auth.js (for _supabase client),
 * kimai-config.js (for KIMAI_EDGE_FN constant).
 * All methods are async.
 */
const WTPData = (() => {
  'use strict';

  // Re-use the Supabase client from auth.js to share the session
  const _db = WTPAuth._supabase;

  // ─── Constants ─-

  const JOB_DESCRIPTIONS = [
    'General Labor', 'Equipment Operation', 'Skilled Trade',
    'Administrative', 'Travel', 'Driving', 'Handyman',
    'Carpentry', 'Cleaning', 'Warehouse', 'Office',
  ];

  const PAY_TYPES = ['Regular', 'Overtime', 'Double Time', 'Holiday'];

  // localStorage keys for offline timer resilience
  const CLOCK_STORAGE = {
    activeShift:    'wtp_active_shift',   // { timesheetId, kimaiId, clockIn (ISO), jobName, activityName, payType }
    pendingClockOut: 'wtp_pending_out',   // { timesheetId, kimaiId, clockIn, clockOut (ISO), hours } — set when offline
  };

  // ─── Row Mapping ──
  // Maps the new timesheets schema columns → the app's camelCase keys.
  // profiles join (select '*, profiles(full_name)') populates employeeName.

  function _fromRow(row) {
    return {
      id:              row.id,
      employeeName:    row.profiles?.full_name || '',
      employeeId:      row.employee_id,
      date:            row.date,
      jobName:         row.project_name,
      jobDescription:  row.task_description,
      payType:         row.pay_type,
      hours:           parseFloat(row.hours_worked || 0),
      timestamp:       row.created_at,
      clockIn:         row.date && row.start_time ? (row.date + 'T' + row.start_time) : null,
      clockOut:        row.date && row.end_time   ? (row.date + 'T' + row.end_time)   : null,
      status:          row.status,
      approved:        row.approved,
      flagged:         row.flagged,
      auto_clocked_out: row.auto_clocked_out || false,
      notes:           row.notes || '',
    };
  }

  // ─── Job Sites ──

  /** Fetch job sites. Pass includeArchived=true to include archived ones. */
  async function getJobSites(includeArchived = false) {
    let query = _db
      .from('job_sites')
      .select('id, name, is_active, archived')
      .order('name', { ascending: true });
    if (!includeArchived) query = query.neq('archived', true);
    const { data, error } = await query;
    if (error) { console.error('WTPData.getJobSites:', error.message); return []; }
    return data || [];
  }

  /** Archive or unarchive a job site. */
  async function archiveJobSite(id, archived) {
    const { error } = await _db
      .from('job_sites')
      .update({ archived })
      .eq('id', id);
    if (error) { console.error('WTPData.archiveJobSite:', error.message); throw error; }
  }

  /** Insert a new job site. Returns the created row or throws. */
  async function addJobSite(name) {
    const { data, error } = await _db
      .from('job_sites')
      .insert({ name: name.trim() })
      .select()
      .single();
    if (error) { console.error('WTPData.addJobSite:', error.message); throw error; }
    return data;
  }

  /** Activate or deactivate a job site. */
  async function toggleJobSite(id, isActive) {
    const { error } = await _db
      .from('job_sites')
      .update({ is_active: isActive })
      .eq('id', id);
    if (error) { console.error('WTPData.toggleJobSite:', error.message); throw error; }
  }

  // ─── Kimai Config ───

  /** Read current Kimai config (base_url, default IDs — token is server-side). */
  async function getKimaiConfig() {
    const { data } = await _db
      .from('kimai_config')
      .select('base_url, default_project_id, default_activity_id, updated_at')
      .maybeSingle();
    return data || null;
  }

  /** Save Kimai config (base URL, token, default project/activity IDs). */
  async function saveKimaiConfig(baseUrl, token, defaultProjectId, defaultActivityId) {
    const { error } = await _db
      .from('kimai_config')
      .upsert({
        id:                  1,
        base_url:            baseUrl.trim(),
        token:               token.trim(),
        default_project_id:  defaultProjectId  || null,
        default_activity_id: defaultActivityId || null,
        updated_at:          new Date().toISOString(),
      });
    if (error) { console.error('WTPData.saveKimaiConfig:', error.message); throw error; }
  }

  // ─── Employees ───

  /** Fetch all employees (manager only via RLS). Queries legacy employees table. */
  async function getEmployees() {
    const { data, error } = await _db
      .from('employees')
      .select('*')
      .order('full_name', { ascending: true });
    if (error) { console.error('WTPData.getEmployees:', error.message); throw error; }
    return data || [];
  }

  /** Update employee fields (name, pay rates, role). */
  async function updateEmployee(id, changes) {
    const allowed = [
      'full_name', 'pay_rate_regular', 'pay_rate_overtime',
      'pay_rate_doubletime', 'pay_rate_holiday', 'role',
    ];
    const patch = {};
    allowed.forEach(k => { if (changes[k] !== undefined) patch[k] = changes[k]; });

    const { data, error } = await _db
      .from('employees')
      .update(patch)
      .eq('id', id)
      .select();
    if (error) { console.error('WTPData.updateEmployee:', error.message); throw error; }
    return data?.[0] || null;
  }

  /** Activate or deactivate an employee account. */
  async function toggleEmployee(id, isActive) {
    const { error } = await _db
      .from('employees')
      .update({ is_active: isActive })
      .eq('id', id);
    if (error) { console.error('WTPData.toggleEmployee:', error.message); throw error; }
  }

  // ─── Clock In / Out (Kimai-backed, offline-aware) ───

  /**
   * Clock an employee in.
   * Writes an in_progress row to Supabase immediately, saves shift to localStorage
   * for offline timer display, then attempts Kimai clock-in non-fatally using the
   * hardcoded default_project_id / default_activity_id from kimai_config.
   *
   * @param {string} employeeId  — auth user UUID (session.user.id)
   * @param {string} jobName     — selected job site name (saved to Supabase only)
   * @param {string} activityName — selected activity name (saved to Supabase only)
   * @param {string} payType     — 'Regular' | 'Overtime' | 'Double Time' | 'Holiday'
   * @returns {object} shift — localStorage shift object
   */
  async function clockIn(employeeId, jobName, activityName, payType = 'Regular') {
    const now        = new Date();
    const clockInISO = now.toISOString();

    // 1. Write in_progress row to Supabase immediately
    const { data: entry, error } = await _db
      .from('timesheets')
      .insert({
        employee_id:      employeeId,
        date:             now.toISOString().slice(0, 10),
        project_name:     jobName,
        task_description: activityName,
        pay_type:         payType,
        start_time:       now.toTimeString().slice(0, 8),
        hours_worked:     0.01, // placeholder — satisfies NOT NULL; updated on clock out
        status:           'in_progress',
      })
      .select()
      .single();
    if (error) throw error;

    // 2. Save to localStorage immediately — timer works offline from here
    const shift = {
      timesheetId:  entry.id,
      kimaiId:      null, // filled in after Kimai responds
      clockIn:      clockInISO,
      jobName,
      activityName,
      payType,
    };
    localStorage.setItem(CLOCK_STORAGE.activeShift, JSON.stringify(shift));

    // 3. Attempt Kimai clock-in using hardcoded default IDs (non-blocking)
    const kimaiCfg = await getKimaiConfig();
    const kimaiProjectId  = kimaiCfg?.default_project_id  || null;
    const kimaiActivityId = kimaiCfg?.default_activity_id || null;

    if (kimaiProjectId || kimaiActivityId) {
      try {
        const begin =
          now.getFullYear() + '-' +
          String(now.getMonth() + 1).padStart(2, '0') + '-' +
          String(now.getDate()).padStart(2, '0') + 'T' +
          String(now.getHours()).padStart(2, '0') + ':' +
          String(now.getMinutes()).padStart(2, '0') + ':' +
          String(now.getSeconds()).padStart(2, '0');

        const session = await _db.auth.getSession();
        const kimaiResp = await fetch(KIMAI_EDGE_FN, {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + session.data.session.access_token,
            'Content-Type':  'application/json',
          },
          body: JSON.stringify({
            action:  'start',
            payload: {
              begin,
              project:  kimaiProjectId,
              activity: kimaiActivityId,
              tags:     payType,
              billable: true,
            },
          }),
        });

        if (kimaiResp.ok) {
          const kimaiEntry = await kimaiResp.json();
          shift.kimaiId = kimaiEntry.id;
          localStorage.setItem(CLOCK_STORAGE.activeShift, JSON.stringify(shift));
          // Also persist kimaiId to Supabase row for later clock-out
          await _db.from('timesheets')
            .update({ kimai_timesheet_id: kimaiEntry.id })
            .eq('id', entry.id);
        }
      } catch (kimaiErr) {
        // Kimai failure is non-fatal — localStorage timer still runs
        console.warn('Kimai clock-in failed (non-fatal):', kimaiErr.message);
      }
    }

    return shift;
  }

  /**
   * Clock the current employee out.
   * Reads active shift from localStorage, attempts Kimai stop for authoritative
   * duration, updates Supabase row to completed.
   * If offline: queues the clock-out in localStorage and returns { offline: true }.
   *
   * @returns {{ offline: boolean, hours: number }}
   */
  async function clockOut() {
    const raw = localStorage.getItem(CLOCK_STORAGE.activeShift);
    if (!raw) throw new Error('No active shift found');
    const shift = JSON.parse(raw);

    const clockOutTime = new Date();
    const clockInTime  = new Date(shift.clockIn);
    const rawHours     = (clockOutTime - clockInTime) / 3600000;
    const hours        = Math.max(0.25, Math.round(rawHours * 4) / 4); // min 0.25, nearest quarter

    // If offline — queue and return early
    if (!navigator.onLine) {
      const pending = {
        timesheetId: shift.timesheetId,
        kimaiId:     shift.kimaiId,
        clockIn:     shift.clockIn,
        clockOut:    clockOutTime.toISOString(),
        hours,
      };
      localStorage.setItem(CLOCK_STORAGE.pendingClockOut, JSON.stringify(pending));
      localStorage.removeItem(CLOCK_STORAGE.activeShift);
      return { offline: true, hours };
    }

    // Online — try Kimai stop first for authoritative server-side duration
    let finalHours = hours;
    if (shift.kimaiId) {
      try {
        const session = await _db.auth.getSession();
        const kimaiResp = await fetch(KIMAI_EDGE_FN, {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + session.data.session.access_token,
            'Content-Type':  'application/json',
          },
          body: JSON.stringify({ action: 'stop', timesheetId: shift.kimaiId }),
        });
        if (kimaiResp.ok) {
          const stopped = await kimaiResp.json();
          if (stopped.duration) {
            finalHours = Math.max(0.25, Math.round((stopped.duration / 3600) * 4) / 4);
          }
        }
      } catch (kimaiErr) {
        console.warn('Kimai clock-out failed — using local duration:', kimaiErr.message);
      }
    }

    // Update Supabase row to completed with final hours
    const { error } = await _db.from('timesheets').update({
      hours_worked: finalHours,
      end_time:     clockOutTime.toTimeString().slice(0, 8),
      status:       'completed',
    }).eq('id', shift.timesheetId);
    if (error) throw error;

    localStorage.removeItem(CLOCK_STORAGE.activeShift);
    return { offline: false, hours: finalHours };
  }

  /**
   * Get the current active shift from localStorage (no network call).
   * Returns the shift object or null if not clocked in.
   */
  function getActiveShift() {
    const raw = localStorage.getItem(CLOCK_STORAGE.activeShift);
    return raw ? JSON.parse(raw) : null;
  }

  /**
   * Sync a pending offline clock-out. Call on page load and on 'online' event.
   * Returns the synced pending object or null if nothing to sync.
   */
  async function syncPendingClockOut() {
    const raw = localStorage.getItem(CLOCK_STORAGE.pendingClockOut);
    if (!raw || !navigator.onLine) return null;

    const pending = JSON.parse(raw);

    // Attempt Kimai stop (best-effort)
    if (pending.kimaiId) {
      try {
        const session = await _db.auth.getSession();
        await fetch(KIMAI_EDGE_FN, {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + session.data.session.access_token,
            'Content-Type':  'application/json',
          },
          body: JSON.stringify({ action: 'stop', timesheetId: pending.kimaiId }),
        });
      } catch (e) {
        console.warn('Kimai sync stop failed (non-fatal):', e.message);
      }
    }

    // Update Supabase row to completed
    await _db.from('timesheets').update({
      hours_worked: pending.hours,
      end_time:     new Date(pending.clockOut).toTimeString().slice(0, 8),
      status:       'completed',
    }).eq('id', pending.timesheetId);

    localStorage.removeItem(CLOCK_STORAGE.pendingClockOut);
    return pending;
  }

  /**
   * Clock out an employee from the manager dashboard.
   * Attempts Kimai stop, then updates the Supabase row to completed.
   * @param {string} shiftId           — timesheets row UUID
   * @param {string|null} kimaiId      — Kimai timesheet ID (may be null)
   * @returns {{ hours: number }}
   */
  async function managerClockOut(shiftId, kimaiId, customClockOutISO) {
    const clockOutTime = customClockOutISO ? new Date(customClockOutISO) : new Date();

    // Fetch shift to get clock-in time
    const { data: shift, error: fetchErr } = await _db
      .from('timesheets')
      .select('created_at')
      .eq('id', shiftId)
      .single();
    if (fetchErr) throw fetchErr;

    const rawHours = (clockOutTime - new Date(shift.created_at)) / 3600000;
    let finalHours = Math.max(0.25, Math.round(rawHours * 4) / 4);

    // Attempt Kimai stop (non-fatal)
    if (kimaiId) {
      try {
        const session = await _db.auth.getSession();
        const kimaiResp = await fetch(KIMAI_EDGE_FN, {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + session.data.session.access_token,
            'Content-Type':  'application/json',
          },
          body: JSON.stringify({ action: 'stop', timesheetId: kimaiId }),
        });
        if (kimaiResp.ok) {
          const stopped = await kimaiResp.json();
          if (stopped.duration) {
            finalHours = Math.max(0.25, Math.round((stopped.duration / 3600) * 4) / 4);
          }
        }
      } catch (e) {
        console.warn('Kimai manager clock-out failed (non-fatal):', e.message);
      }
    }

    const { error } = await _db.from('timesheets').update({
      hours_worked: finalHours,
      end_time:     clockOutTime.toTimeString().slice(0, 8),
      status:       'completed',
    }).eq('id', shiftId);
    if (error) throw error;

    return { hours: finalHours };
  }

  /**
   * Create a completed timesheet entry in the past (manager-only).
   * @param {{ employeeId, projectName, taskDescription, payType, date, startTime?, endTime?, hoursWorked?, notes? }}
   */
  async function createPastEntry({ employeeId, projectName, taskDescription, payType, date, startTime, endTime, hoursWorked, notes }) {
    let hours = hoursWorked ? parseFloat(hoursWorked) : null;
    if (!hours && startTime && endTime) {
      const start = new Date(date + 'T' + startTime);
      const end   = new Date(date + 'T' + endTime);
      hours = Math.round(((end - start) / 3600000) * 4) / 4 || 0.25;
    }
    if (!hours || hours <= 0) throw new Error('Could not calculate hours — provide start/end times or hours_worked.');

    const { data, error } = await _db
      .from('timesheets')
      .insert({
        employee_id:      employeeId,
        date,
        project_name:     projectName,
        task_description: taskDescription,
        pay_type:         payType || 'Regular',
        start_time:       startTime || null,
        end_time:         endTime   || null,
        hours_worked:     hours,
        status:           'completed',
        notes:            notes || null,
      })
      .select('*, profiles(full_name)')
      .single();
    if (error) throw error;
    return _fromRow(data);
  }

  /**
   * Get active shift from DB for a specific employee (fallback; not used by the
   * updated employee.html which reads from localStorage via getActiveShift()).
   */
  async function getMyActiveShift(employeeId) {
    const { data, error } = await _db
      .from('timesheets')
      .select('*')
      .eq('employee_id', employeeId)
      .eq('status', 'in_progress')
      .maybeSingle();
    if (error) { console.error('WTPData.getMyActiveShift:', error.message); return null; }
    return data;
  }

  /**
   * Get all currently clocked-in employees (manager only via RLS).
   * Queries timesheets with status='in_progress' and joins profiles for names.
   */
  async function getActiveShifts() {
    const { data, error } = await _db
      .from('timesheets')
      .select('*, profiles(full_name)')
      .eq('status', 'in_progress')
      .order('created_at', { ascending: true });
    if (error) { console.error('WTPData.getActiveShifts:', error.message); return []; }
    return (data || []).map(s => ({
      id:                  s.id,
      employee_name:       s.profiles?.full_name || 'Unknown',
      employee_id:         s.employee_id,
      job_name:            s.project_name,
      job_description:     s.task_description,
      pay_type:            s.pay_type,
      clock_in:            s.created_at, // ISO TIMESTAMPTZ — used for elapsed timer
      kimai_timesheet_id:  s.kimai_timesheet_id || null,
    }));
  }

  // ─── Timesheet CRUD ──

  /** Fetch all completed timesheet entries, most recent first. */
  async function getAll() {
    const { data, error } = await _db
      .from('timesheets')
      .select('*, profiles(full_name)')
      .eq('status', 'completed')
      .order('date', { ascending: false });
    if (error) { console.error('WTPData.getAll:', error.message); return []; }
    return (data || []).map(_fromRow);
  }

  /** Update a timesheet entry's editable fields. */
  async function update(id, changes) {
    const rowChanges = {};
    if (changes.date           !== undefined) rowChanges.date             = changes.date;
    if (changes.jobName        !== undefined) rowChanges.project_name     = changes.jobName;
    if (changes.jobDescription !== undefined) rowChanges.task_description = changes.jobDescription;
    if (changes.payType        !== undefined) rowChanges.pay_type         = changes.payType;
    if (changes.hours          !== undefined) rowChanges.hours_worked     = parseFloat(changes.hours);
    // Note: employeeName lives in profiles — not writable via timesheets update

    const { data, error } = await _db
      .from('timesheets')
      .update(rowChanges)
      .eq('id', id)
      .select('*, profiles(full_name)')
      .single();
    if (error) { console.error('WTPData.update:', error.message); return null; }
    return _fromRow(data);
  }

  /** Delete a timesheet entry by ID. */
  async function remove(id) {
    const { error } = await _db.from('timesheets').delete().eq('id', id);
    if (error) console.error('WTPData.remove:', error.message);
  }

  /**
   * Filter completed timesheet entries server-side by date range, job site, pay type.
   * Employee name is filtered client-side after the join.
   * @param {{ startDate?, endDate?, employee?, jobSite?, payType? }} opts
   */
  async function filterEntries({ startDate, endDate, employee, jobSite, payType } = {}) {
    let query = _db
      .from('timesheets')
      .select('*, profiles(full_name)')
      .eq('status', 'completed')
      .order('date', { ascending: false });
    if (startDate) query = query.gte('date', startDate);
    if (endDate)   query = query.lte('date', endDate);
    if (jobSite)   query = query.eq('project_name', jobSite);
    if (payType)   query = query.eq('pay_type', payType);

    const { data, error } = await query;
    if (error) { console.error('WTPData.filterEntries:', error.message); return []; }

    let rows = (data || []).map(_fromRow);

    if (employee) {
      const q = employee.toLowerCase();
      rows = rows.filter(e => (e.employeeName || '').toLowerCase().includes(q));
    }

    return rows;
  }

  /**
   * Return this employee's completed entries from the last 7 days.
   * @param {string} userId — auth user UUID (session.user.id)
   */
  async function getMyRecentEntries(userId) {
    const since = new Date();
    since.setDate(since.getDate() - 7);
    const { data, error } = await _db
      .from('timesheets')
      .select('*')
      .eq('employee_id', userId)
      .eq('status', 'completed')
      .gte('date', since.toISOString().split('T')[0])
      .order('date', { ascending: false });
    if (error) { console.error('WTPData.getMyRecentEntries:', error.message); return []; }
    return (data || []).map(_fromRow);
  }

  /** Return completed entries for the current Mon–Sun week. */
  async function getThisWeekEntries() {
    const now = new Date();
    const day = now.getDay();
    const mon = new Date(now);
    mon.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
    mon.setHours(0, 0, 0, 0);
    const sun = new Date(mon);
    sun.setDate(mon.getDate() + 6);
    return filterEntries({
      startDate: mon.toISOString().split('T')[0],
      endDate:   sun.toISOString().split('T')[0],
    });
  }

  // ─── Analytics ───

  /** Returns { weekHours, totalEntries } */
  async function getAnalytics() {
    const [weekEntries, allEntries] = await Promise.all([
      getThisWeekEntries(),
      getAll(),
    ]);
    const weekHours = weekEntries.reduce((s, e) => s + e.hours, 0);
    return { weekHours, totalEntries: allEntries.length };
  }

  // ─── CSV Export ──

  /**
   * Export entries to CSV. Sorted by date ascending.
   * Columns: Date, Employee, Job Site, Activity, Pay Type, Hours, Auto Clocked Out, Notes
   */
  function exportToCSV(entries) {
    const sorted  = entries.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const fmtTime = iso => iso ? iso.split('T')[1]?.slice(0, 5) || '' : '';
    const headers = ['Date', 'Employee', 'Job Site', 'Activity', 'Pay Type', 'Hours', 'Clock In', 'Clock Out', 'Auto Clocked Out', 'Notes'];
    const rows    = sorted.map(e => [
      e.date,
      e.employeeName,
      e.jobName,
      e.jobDescription,
      e.payType || 'Regular',
      e.hours,
      fmtTime(e.clockIn),
      fmtTime(e.clockOut),
      e.auto_clocked_out ? 'Y' : 'N',
      e.notes || '',
    ]);
    const totalHours = sorted.reduce((s, e) => s + e.hours, 0);
    const totalRow   = ['', '', '', '', 'TOTAL', Math.round(totalHours * 100) / 100, '', '', '', ''];
    const escape     = v => `"${String(v).replace(/"/g, '""')}"`;
    const csv        = [headers, ...rows, totalRow].map(r => r.map(escape).join(',')).join('\r\n');
    const blob       = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url        = URL.createObjectURL(blob);
    const link       = document.createElement('a');
    link.href        = url;
    link.download    = `wtp_timesheets_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  // ─── Public API ───
  return {
    // Job sites
    getJobSites, addJobSite, toggleJobSite, archiveJobSite,
    // Kimai config
    getKimaiConfig, saveKimaiConfig,
    // Employees
    getEmployees, updateEmployee, toggleEmployee,
    // Clock in/out (Kimai-backed, offline-aware)
    clockIn, clockOut, getActiveShift, syncPendingClockOut,
    // Active shifts (manager)
    getMyActiveShift, getActiveShifts, managerClockOut,
    // Timesheets
    getAll, update, remove, filterEntries, getMyRecentEntries,
    getThisWeekEntries, getAnalytics,
    // Past entry creation (manager)
    createPastEntry,
    // Export
    exportToCSV,
    // Constants
    JOB_DESCRIPTIONS, PAY_TYPES,
  };
})();
