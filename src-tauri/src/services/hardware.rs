//! Hardware + memory detection (Stage 07).
//!
//! One job: answer "what is this machine, and what can it safely spend on
//! one inference tile" — nothing else. Collection is deliberately minimal:
//!
//! - CPU brand string (public `HKLM\HARDWARE\DESCRIPTION` value, not a
//!   per-machine identifier), physical and logical core counts,
//! - GPU adapters via DXGI: name, PCI vendor id, dedicated/shared memory,
//!   plus a real DirectX 12 feature-level probe (`D3D12CreateDevice`) —
//!   the same bar DirectML needs,
//! - total and currently-free physical memory,
//! - this process's working set (benchmark harness + diagnostics only).
//!
//! No serial numbers, no device instance paths, no machine IDs, no user
//! profile. Everything reported is a hardware fact Task Manager could
//! show; none of it identifies a person or a specific device.
//!
//! Every probe is failure-tolerant: a Win32 call that fails yields an
//! unknown/zero value, never an error — the engine must start even when
//! detection misbehaves. Non-Windows builds compile to honest unknowns
//! (the product targets Windows; the crate must still build and test
//! elsewhere).

use std::sync::OnceLock;

use serde::Serialize;

/// MiB helper for budget math.
const MIB: usize = 1 << 20;

/// One DXGI adapter on this machine.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuInfo {
    /// Adapter description, e.g. "NVIDIA GeForce RTX 3050 Laptop GPU".
    pub name: String,
    /// PCI vendor id (0x10DE NVIDIA, 0x1002 AMD, 0x8086 Intel …).
    pub vendor_id: u32,
    /// Dedicated video memory (VRAM) in bytes; 0 for integrated adapters
    /// that draw on system RAM.
    pub dedicated_video_bytes: u64,
    /// System memory the adapter may share into, in bytes.
    pub shared_system_bytes: u64,
    /// The Microsoft Basic Render Driver — software rasterizer, never a
    /// real acceleration target.
    pub software: bool,
    /// This adapter passed a DirectX 12 feature-level 12_0 device create —
    /// DirectML can actually run on it.
    pub directx12: bool,
}

/// Everything Fovea knows about the machine it runs on. The full snapshot
/// is what Settings → Diagnostics displays and what the engine budgets
/// derive from; it is collected once per process and cached.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareInfo {
    /// CPU brand string; "Unknown processor" when the probe fails.
    pub cpu_name: String,
    /// Physical cores (SMT collapsed); 0 when unknown.
    pub physical_cores: usize,
    /// Logical processors available to the process.
    pub logical_processors: usize,
    /// Installed physical memory in bytes; 0 when unknown.
    pub total_memory_bytes: u64,
    /// Currently free physical memory in bytes; 0 when unknown.
    pub available_memory_bytes: u64,
    /// All DXGI adapters, enumeration order.
    pub gpus: Vec<GpuInfo>,
}

impl HardwareInfo {
    /// The adapter the engine would most plausibly run on: a DirectX 12
    /// capable, non-software one with the most dedicated VRAM. None when
    /// no such adapter exists — the honest CPU-only verdict.
    pub fn acceleration_gpu(&self) -> Option<&GpuInfo> {
        self.gpus
            .iter()
            .filter(|g| g.directx12 && !g.software)
            .max_by_key(|g| g.dedicated_video_bytes)
    }

    /// Human summary line for diagnostics ("NVIDIA GeForce RTX 3050 ·
    /// 4 GB VRAM" / "CPU (no DirectX 12 GPU found)").
    pub fn accelerator_summary(&self) -> String {
        match self.acceleration_gpu() {
            Some(g) => format!(
                "{} · {} GB VRAM",
                g.name,
                (g.dedicated_video_bytes as f64 / (1024.0 * 1024.0 * 1024.0))
                    .round()
                    .max(1.0)
            ),
            None => "CPU (no DirectX 12 GPU found)".into(),
        }
    }

    /// The memory figure the *tile* budget is squeezed by — what to call
    /// it in diagnostics, following the same branch as `memory_budgets`.
    pub fn memory_limit_label(&self) -> &'static str {
        if self.acceleration_gpu().is_some() {
            "GPU video memory"
        } else {
            "system memory"
        }
    }
}

/// The cached process snapshot — GPUs do not hot-plug on Windows, and every
/// consumer (budgets, diagnostics, benchmark harness) must see the *same*
/// facts.
pub fn detect() -> &'static HardwareInfo {
    static INFO: OnceLock<HardwareInfo> = OnceLock::new();
    INFO.get_or_init(|| {
        let info = detect_now();
        log::info!(
            "hardware: {} ({} phys / {} log cores), {} MB RAM ({} MB free), {}",
            info.cpu_name,
            info.physical_cores,
            info.logical_processors,
            info.total_memory_bytes / MIB as u64,
            info.available_memory_bytes / MIB as u64,
            info.accelerator_summary(),
        );
        info
    })
}

/// The tile/band memory budgets the engine sizes work against.
///
/// These are deliberately conservative *models* of Fovea's own buffers —
/// the runtime's arena, the image decoder, and every other app on the
/// machine are invisible here, so only a fraction of any pool is claimed:
/// a quarter of the applicable pool for the inference tile, a quarter of
/// free RAM for the streaming band buffer. Floor values guarantee a 64 px
/// tile (~2 MB of float at 4×) always fits, so detection failures can
/// never starve the strategy; ceiling values stop the engine from being
/// greedy on a 64 GB workstation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MemoryBudgets {
    /// Cap on one tile's *model-output* float buffer (3·(t·s)²·4 bytes).
    pub max_tile_bytes: usize,
    /// Cap on one composited output band's u8 buffer.
    pub max_band_bytes: usize,
}

pub fn memory_budgets(hw: &HardwareInfo) -> MemoryBudgets {
    budgets_for(hw, hw.acceleration_gpu().is_some())
}

/// The same budgets *ignoring* any GPU — the RAM-limited figures the CPU
/// inference path runs against (used when a GPU attempt fails or is
/// unavailable at retry time).
pub fn cpu_only_budgets(hw: &HardwareInfo) -> MemoryBudgets {
    budgets_for(hw, false)
}

fn budgets_for(hw: &HardwareInfo, consider_gpu: bool) -> MemoryBudgets {
    // Free RAM is the honest denominator. When the probe failed (0 —
    // non-Windows, exotic policy), assume a modest 2 GiB pool instead of
    // the (false) security of no constraint: full 256 px tiles still fit,
    // and real pressure on Windows is reported truthfully below.
    let ram = if hw.available_memory_bytes == 0 {
        2048 * MIB
    } else {
        hw.available_memory_bytes as usize
    };
    let mut tile_pool = ram / 4;
    if consider_gpu {
        if let Some(gpu) = hw.acceleration_gpu() {
            // A DirectML run is bounded by VRAM, not by RAM — take the
            // tighter of the two quarters. Integrated adapters report 0
            // dedicated memory; DirectML then draws on the shared system
            // pool, so halve the RAM quarter instead.
            let pool = if gpu.dedicated_video_bytes > 0 {
                (gpu.dedicated_video_bytes as usize) / 4
            } else {
                tile_pool / 2
            };
            tile_pool = tile_pool.min(pool);
        }
    }
    MemoryBudgets {
        max_tile_bytes: tile_pool.clamp(64 * MIB, 512 * MIB),
        // The band buffer is Fovea's own RAM; half-a-gig is plenty —
        // a 4096-wide source at 4× with 256 px tiles needs ~470 MB.
        max_band_bytes: (ram / 4).clamp(32 * MIB, 512 * MIB),
    }
}

/// This process's memory usage (for the benchmark harness and
/// diagnostics). `None` where the OS call is unavailable.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessMemory {
    pub working_set_bytes: u64,
    pub peak_working_set_bytes: u64,
}

/// This process's current/peak working set — `None` where unsupported.
pub fn process_memory() -> Option<ProcessMemory> {
    process_memory_now()
}

// ── Windows implementation ───────────────────────────────────────────

#[cfg(windows)]
fn detect_now() -> HardwareInfo {
    use windows::Win32::Graphics::Direct3D::D3D_FEATURE_LEVEL_12_0;
    use windows::Win32::Graphics::Direct3D12::{D3D12CreateDevice, ID3D12Device};
    use windows::Win32::Graphics::Dxgi::{
        CreateDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE, IDXGIFactory1,
    };

    // ── GPUs via DXGI + a real D3D12 capability probe ─────────────────
    let mut gpus: Vec<GpuInfo> = Vec::new();
    unsafe {
        // No DXGI at all (ancient driver stack): honest "no GPU" — the
        // engine then budgets and runs on CPU.
        if let Ok(factory) = CreateDXGIFactory1::<IDXGIFactory1>() {
            for i in 0..8u32 {
                let Ok(adapter) = factory.EnumAdapters1(i) else {
                    break;
                };
                let Ok(desc) = adapter.GetDesc1() else {
                    continue;
                };
                let software = desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0;
                // Authoritative DX12 probe: ask D3D12 to create a minimum
                // 12_0 device on *this* adapter. We only need the HRESULT;
                // failing drivers return cleanly here, never panic.
                let mut device: Option<ID3D12Device> = None;
                let directx12 =
                    D3D12CreateDevice(&adapter, D3D_FEATURE_LEVEL_12_0, &mut device).is_ok();
                gpus.push(GpuInfo {
                    name: trim_utf16(&desc.Description),
                    vendor_id: desc.VendorId,
                    dedicated_video_bytes: desc.DedicatedVideoMemory as u64,
                    shared_system_bytes: desc.SharedSystemMemory as u64,
                    software,
                    directx12,
                });
            }
        } else {
            log::warn!("DXGI factory unavailable — GPU enumeration reports none");
        }
    }
    with_cpu_and_memory(gpus)
}

#[cfg(windows)]
fn with_cpu_and_memory(gpus: Vec<GpuInfo>) -> HardwareInfo {
    use windows::Win32::System::SystemInformation::{
        GetPhysicallyInstalledSystemMemory, GlobalMemoryStatusEx, MEMORYSTATUSEX,
    };
    let mut total = 0u64;
    let mut avail = 0u64;
    unsafe {
        let mut status = MEMORYSTATUSEX {
            dwLength: core::mem::size_of::<MEMORYSTATUSEX>() as u32,
            ..Default::default()
        };
        if GlobalMemoryStatusEx(&mut status).is_ok() {
            total = status.ullTotalPhys;
            avail = status.ullAvailPhys;
        }
    }
    if total == 0 {
        unsafe {
            let mut kb: u64 = 0;
            if GetPhysicallyInstalledSystemMemory(&mut kb).is_ok() {
                total = kb * 1024;
            }
        }
    }
    HardwareInfo {
        cpu_name: cpu_name(),
        physical_cores: physical_core_count(),
        logical_processors: std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1),
        total_memory_bytes: total,
        available_memory_bytes: avail,
        gpus,
    }
}

/// Registry read of the CPU brand string. `HKLM\HARDWARE\DESCRIPTION\…`
/// is the same value every system tool shows; it carries no per-machine
/// identity.
#[cfg(windows)]
fn cpu_name() -> String {
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{
        HKEY, HKEY_LOCAL_MACHINE, KEY_READ, RegCloseKey, RegOpenKeyExW, RegQueryValueExW,
    };
    use windows::core::PCWSTR;
    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }
    unsafe {
        let mut hkey = HKEY::default();
        let path = wide("HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0");
        if RegOpenKeyExW(
            HKEY_LOCAL_MACHINE,
            PCWSTR(path.as_ptr()),
            None,
            KEY_READ,
            &mut hkey,
        ) != ERROR_SUCCESS
        {
            return "Unknown processor".into();
        }
        let name = wide("ProcessorNameString");
        let mut buf = [0u8; 512];
        let mut len = buf.len() as u32;
        let value = if RegQueryValueExW(
            hkey,
            PCWSTR(name.as_ptr()),
            None,
            None,
            Some(buf.as_mut_ptr()),
            Some(&mut len),
        ) == ERROR_SUCCESS
        {
            let units: Vec<u16> = buf[..len as usize]
                .chunks_exact(2)
                .map(|p| u16::from_le_bytes([p[0], p[1]]))
                .take_while(|u| *u != 0)
                .collect();
            String::from_utf16_lossy(&units).trim().to_string()
        } else {
            String::new()
        };
        let _ = RegCloseKey(hkey);
        if value.is_empty() {
            "Unknown processor".into()
        } else {
            value
        }
    }
}

#[cfg(windows)]
fn physical_core_count() -> usize {
    use windows::Win32::System::SystemInformation::{
        GetLogicalProcessorInformationEx, RelationProcessorCore,
        SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX,
    };
    unsafe {
        let mut len: u32 = 0;
        // First call is the size probe; failing with
        // ERROR_INSUFFICIENT_BUFFER is the documented success path.
        let _ = GetLogicalProcessorInformationEx(RelationProcessorCore, None, &mut len);
        if len == 0 {
            return 0;
        }
        let mut buf = vec![0u8; len as usize];
        let mut written = len;
        if GetLogicalProcessorInformationEx(
            RelationProcessorCore,
            Some(buf.as_mut_ptr() as *mut _),
            &mut written,
        )
        .is_err()
        {
            return 0;
        }
        let mut cores = 0usize;
        let mut off = 0usize;
        let step = core::mem::size_of::<SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX>();
        while off + step <= written as usize {
            let record: SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX =
                core::ptr::read_unaligned(buf.as_ptr().add(off) as *const _);
            if record.Relationship == RelationProcessorCore {
                cores += 1;
            }
            if record.Size == 0 {
                break; // defensive: a zero-size record would spin forever
            }
            off += record.Size as usize;
        }
        cores
    }
}

#[cfg(windows)]
fn trim_utf16(raw: &[u16]) -> String {
    let end = raw.iter().position(|&c| c == 0).unwrap_or(raw.len());
    String::from_utf16_lossy(&raw[..end]).trim().to_string()
}

#[cfg(windows)]
fn process_memory_now() -> Option<ProcessMemory> {
    use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows::Win32::System::Threading::GetCurrentProcess;
    unsafe {
        let mut counters = PROCESS_MEMORY_COUNTERS {
            cb: core::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
            ..Default::default()
        };
        GetProcessMemoryInfo(
            GetCurrentProcess(),
            &mut counters,
            core::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
        )
        .ok()?;
        Some(ProcessMemory {
            working_set_bytes: counters.WorkingSetSize as u64,
            peak_working_set_bytes: counters.PeakWorkingSetSize as u64,
        })
    }
}

// ── Non-Windows fallbacks ────────────────────────────────────────────
// Fovea targets Windows; these keep the crate building (and its tests
// running) elsewhere, reporting honest unknowns instead of lies.

#[cfg(not(windows))]
fn detect_now() -> HardwareInfo {
    HardwareInfo {
        cpu_name: "Unknown processor".into(),
        physical_cores: 0,
        logical_processors: std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1),
        total_memory_bytes: 0,
        available_memory_bytes: 0,
        gpus: Vec::new(),
    }
}

#[cfg(not(windows))]
fn process_memory_now() -> Option<ProcessMemory> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gpu(name: &str, dedicated: u64, software: bool, dx12: bool) -> GpuInfo {
        GpuInfo {
            name: name.into(),
            vendor_id: 0,
            dedicated_video_bytes: dedicated,
            shared_system_bytes: dedicated / 2,
            software,
            directx12: dx12,
        }
    }

    fn hw(gpus: Vec<GpuInfo>, avail: u64) -> HardwareInfo {
        HardwareInfo {
            cpu_name: "test".into(),
            physical_cores: 4,
            logical_processors: 8,
            total_memory_bytes: avail * 2,
            available_memory_bytes: avail,
            gpus,
        }
    }

    #[test]
    fn acceleration_gpu_requires_dx12_and_skips_software() {
        let info = hw(
            vec![
                gpu("Microsoft Basic Render", 0, true, true),
                gpu("Old GeForce 8", 512 * MIB as u64, false, false),
                gpu("Intel UHD", 128 * MIB as u64, false, true),
                gpu("NVIDIA RTX", 4 * 1024 * MIB as u64, false, true),
            ],
            8 * 1024 * MIB as u64,
        );
        assert_eq!(info.acceleration_gpu().unwrap().name, "NVIDIA RTX");
    }

    #[test]
    fn cpu_only_machine_has_no_acceleration_gpu() {
        let info = hw(vec![gpu("Old GPU", 1024 * MIB as u64, false, false)], 0);
        assert!(info.acceleration_gpu().is_none());
        assert!(info.accelerator_summary().contains("CPU"));
    }

    #[test]
    fn gpu_run_squeezes_tile_budget_by_vram() {
        // 4 GB VRAM → VRAM/4 = 1 GiB; RAM plentiful → tile clamps to the
        // 512 MiB ceiling; band buffer clamps to 512 MiB.
        let info = hw(
            vec![gpu("RTX", 4 * 1024 * MIB as u64, false, true)],
            8 * 1024 * MIB as u64,
        );
        let b = memory_budgets(&info);
        assert_eq!(b.max_tile_bytes, 512 * MIB);
        assert_eq!(b.max_band_bytes, 512 * MIB);
    }

    #[test]
    fn tiny_vram_floors_the_tile_budget() {
        // 200 MB VRAM → 50 MB pool → floors at 64 MB (a 64 px tile at 4×
        // with bleed is ~2 MB; the floor guarantees detection failures can
        // never starve the strategy).
        let b = memory_budgets(&hw(
            vec![gpu("Weird", 200 * MIB as u64, false, true)],
            4 * 1024 * MIB as u64,
        ));
        assert_eq!(b.max_tile_bytes, 64 * MIB);
    }

    #[test]
    fn integrated_dx12_gpu_halves_the_ram_pool() {
        // Dedicated == 0 → DirectML draws on shared RAM: half the quarter.
        let b = memory_budgets(&hw(
            vec![gpu("iGPU", 0, false, true)],
            8 * 1024 * MIB as u64,
        ));
        assert_eq!(b.max_tile_bytes, 512 * MIB); // 8192/4=2048, /2=1024 → clamp 512
    }

    #[test]
    fn cpu_only_budgets_from_free_ram() {
        let b = memory_budgets(&hw(vec![], 2 * 1024 * MIB as u64));
        assert_eq!(b.max_tile_bytes, 512 * MIB); // 2048/4 = 512 → at ceiling
        assert_eq!(b.max_band_bytes, 512 * MIB);
    }

    #[test]
    fn scarce_ram_shrinks_both_budgets() {
        // 640 MB free RAM (a real, honestly-reported number, not a probe
        // failure): the quarter is 160 MB — below the tile ceiling, so it
        // is used. At 256 MB free, the tile pool floors at 64 MB.
        let b = memory_budgets(&hw(vec![], 640 * MIB as u64));
        assert_eq!(b.max_tile_bytes, 160 * MIB);
        assert_eq!(b.max_band_bytes, 160 * MIB);
        let tight = memory_budgets(&hw(vec![], 256 * MIB as u64));
        assert_eq!(tight.max_tile_bytes, 64 * MIB);
        assert_eq!(tight.max_band_bytes, 64 * MIB);
    }

    #[test]
    fn unknown_memory_falls_back_conservatively() {
        let b = memory_budgets(&hw(vec![], 0));
        assert!(b.max_tile_bytes >= 64 * MIB, "floor guarantees work");
        assert!(b.max_band_bytes >= 32 * MIB);
    }

    #[test]
    fn budgets_never_exceed_clamps() {
        let b = memory_budgets(&hw(
            vec![gpu("HUGE", 24 * 1024 * MIB as u64, false, true)],
            64 * 1024 * MIB as u64,
        ));
        assert!(b.max_tile_bytes <= 512 * MIB);
        assert!(b.max_band_bytes <= 1024 * MIB);
    }

    #[test]
    fn detect_reports_a_coherent_snapshot_and_is_cached() {
        let info = detect();
        assert!(info.logical_processors >= 1);
        assert!(!info.cpu_name.is_empty());
        // Cached: the same address across calls (hardware never re-reads).
        assert!(std::ptr::eq(detect(), info));
    }

    #[test]
    fn serializes_camel_case_for_the_ui() {
        let json = serde_json::to_value(detect()).expect("serialize");
        assert!(json.get("cpuName").is_some());
        assert!(json.get("physicalCores").is_some());
        assert!(json.get("totalMemoryBytes").is_some());
        assert!(json.get("availableMemoryBytes").is_some());
        assert!(json.get("gpus").unwrap().is_array());
        if let Some(g) = json.get("gpus").unwrap().get(0) {
            assert!(g.get("dedicatedVideoBytes").is_some());
            assert!(g.get("directx12").is_some());
        }
    }

    #[test]
    fn process_memory_probe_runs_or_is_none() {
        // On Windows this returns real figures; elsewhere honest None.
        let _ = process_memory();
    }
}
