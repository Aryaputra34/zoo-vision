"""
Universal Model Exporter CLI for Zoo & Vision Pipelines.
Supports exporting YOLO models (.pt) to ONNX, OpenVINO, TensorRT, TorchScript, and TFLite.
Supports interactive terminal menu or direct command-line arguments.

Usage Examples:
    # 1. Interactive wizard (prompts you for model, format, resolution, etc.):
    python export_model.py

    # 2. Direct CLI export (Square 1280):
    python export_model.py --model yolo26s.pt --format onnx --imgsz 1280 --dynamic

    # 3. Direct CLI export (16:9 Widescreen CCTV 736x1280 - zero letterbox bars):
    python export_model.py --model yolo26s.pt --format onnx --imgsz 736 1280 --dynamic

    # 4. Export to OpenVINO:
    python export_model.py --model yolo11s.pt --format openvino --imgsz 640

    # 5. List available local models:
    python export_model.py --list
"""

import os
import sys
import time
import argparse
from typing import List, Union
from ultralytics import YOLO


def get_local_models() -> List[str]:
    """Finds all .pt model weights in the current directory and subdirectories."""
    models = []
    for root, _, files in os.walk("."):
        # Skip virtual environments and git
        if ".venv" in root or ".git" in root or "__pycache__" in root:
            continue
        for f in files:
            if f.endswith(".pt"):
                models.append(os.path.normpath(os.path.join(root, f)))
    return sorted(models)


def parse_imgsz(imgsz_arg: List[str]) -> Union[int, List[int]]:
    """Parses one or two ints for imgsz. Ensures multiples of 32."""
    if not imgsz_arg:
        return 640

    if len(imgsz_arg) == 1:
        val = imgsz_arg[0]
        if "," in val:
            parts = [int(p.strip()) for p in val.split(",")]
            return validate_and_round_stride(parts)
        return validate_and_round_stride(int(val))
    elif len(imgsz_arg) == 2:
        parts = [int(imgsz_arg[0]), int(imgsz_arg[1])]
        return validate_and_round_stride(parts)
    else:
        raise ValueError(f"Too many arguments for imgsz: {imgsz_arg}")


def validate_and_round_stride(val: Union[int, List[int]], stride: int = 32) -> Union[int, List[int]]:
    """Ensures input sizes are multiples of 32 (YOLO stride constraint)."""
    if isinstance(val, int):
        if val % stride != 0:
            rounded = int(round(val / stride) * stride)
            print(f"⚠️  Notice: imgsz {val} is not a multiple of {stride}. Adjusted to {rounded}.")
            return rounded
        return val
    elif isinstance(val, list):
        adjusted = []
        for v in val:
            if v % stride != 0:
                adj = int(round(v / stride) * stride)
                print(f"⚠️  Notice: dimension {v} is not a multiple of {stride}. Adjusted to {adj}.")
                adjusted.append(adj)
            else:
                adjusted.append(v)
        return adjusted
    return val


def format_size(bytes_val: int) -> str:
    """Formats file size into human-readable MB."""
    return f"{bytes_val / (1024 * 1024):.1f} MB"


def export_model(
    model_path: str,
    export_format: str = "onnx",
    imgsz: Union[int, List[int]] = 640,
    dynamic: bool = True,
    half: bool = False,
    opset: int = 19,
    simplify: bool = True
):
    if not os.path.exists(model_path):
        print(f"\n❌ Error: Model file '{model_path}' not found!")
        sys.exit(1)

    print("\n" + "=" * 65)
    print(f"🚀 EXPORTING MODEL: {model_path}")
    print("=" * 65)
    print(f"  • Source Model:    {model_path} ({format_size(os.path.getsize(model_path))})")
    print(f"  • Target Format:   {export_format.upper()}")
    print(f"  • Input Size:      {imgsz} {'(Rectangular 16:9)' if isinstance(imgsz, list) else '(Square)'}")
    print(f"  • Dynamic Shapes:  {dynamic}")
    print(f"  • Half Precision:  {half} (FP16)")
    if export_format.lower() == "onnx":
        print(f"  • ONNX Opset:      {opset}")
        print(f"  • Simplify/Slim:   {simplify}")
    print("-" * 65)

    try:
        t0 = time.time()
        model = YOLO(model_path)

        export_kwargs = {
            "format": export_format,
            "imgsz": imgsz,
            "dynamic": dynamic,
            "half": half,
        }

        if export_format.lower() == "onnx":
            export_kwargs["opset"] = opset
            export_kwargs["simplify"] = simplify

        exported_path = model.export(**export_kwargs)
        elapsed = time.time() - t0

        print("\n" + "=" * 65)
        print("✅ EXPORT COMPLETED SUCCESSFULLY!")
        print("=" * 65)
        print(f"  • Output Path:     {exported_path}")
        if os.path.exists(exported_path):
            if os.path.isfile(exported_path):
                print(f"  • Output Size:     {format_size(os.path.getsize(exported_path))}")
            elif os.path.isdir(exported_path):
                total_bytes = sum(
                    os.path.getsize(os.path.join(root, f))
                    for root, _, files in os.walk(exported_path)
                    for f in files
                )
                print(f"  • Directory Size:  {format_size(total_bytes)}")
        print(f"  • Export Duration: {elapsed:.2f} seconds")
        print("=" * 65)

        # Quick validation check
        print("\n🔍 Validating exported model load...")
        val_model = YOLO(exported_path, task="detect")
        print(f"✅ Verified: Model successfully loaded into memory via {export_format.upper()} runtime.")

    except Exception as e:
        print(f"\n❌ Export Failed: {e}")
        sys.exit(1)


def interactive_wizard():
    """Interactive CLI wizard for step-by-step model export."""
    print("\n" + "=" * 65)
    print("🧙 UNIVERSAL MODEL EXPORT WIZARD")
    print("=" * 65)

    local_models = get_local_models()
    if not local_models:
        print("❌ No .pt model files found in the current directory.")
        sys.exit(1)

    print("\nStep 1: Select a PyTorch model to export:")
    for idx, m in enumerate(local_models, 1):
        size_str = format_size(os.path.getsize(m))
        print(f"  [{idx}] {m:<30} ({size_str})")

    while True:
        try:
            choice = input(f"\nSelect model [1-{len(local_models)}] (default: 1): ").strip()
            if not choice:
                selected_model = local_models[0]
                break
            idx = int(choice)
            if 1 <= idx <= len(local_models):
                selected_model = local_models[idx - 1]
                break
            print(f"Please enter a number between 1 and {len(local_models)}.")
        except ValueError:
            print("Invalid input. Please enter a valid number.")

    print(f"\n--> Selected: {selected_model}")

    # Format selection
    formats = [
        ("onnx", "ONNX (.onnx) — Universal cross-platform runtime (Recommended)"),
        ("openvino", "Intel OpenVINO — Optimized for Intel CPUs & iGPUs"),
        ("engine", "NVIDIA TensorRT (.engine) — Requires NVIDIA GPU"),
        ("torchscript", "TorchScript (.torchscript) — Compiled PyTorch C++ graph"),
        ("tflite", "TensorFlow Lite (.tflite) — Mobile / Edge devices"),
    ]
    print("\nStep 2: Select target export format:")
    for idx, (fmt, desc) in enumerate(formats, 1):
        print(f"  [{idx}] {desc}")

    fmt_choice = input(f"\nSelect format [1-{len(formats)}] (default: 1 [ONNX]): ").strip()
    selected_format = formats[int(fmt_choice) - 1][0] if fmt_choice and fmt_choice.isdigit() and 1 <= int(fmt_choice) <= len(formats) else "onnx"
    print(f"--> Selected Format: {selected_format.upper()}")

    # Resolution selection
    res_presets = [
        ("640", "640x640 — Fast default (balanced speed/accuracy)"),
        ("1280", "1280x1280 — High detail (better for distant small vehicles/plates)"),
        ("736,1280", "736x1280 — 16:9 Widescreen CCTV (No black letterbox bars, fast)"),
        ("1088,1920", "1088x1920 — Native 1080p Widescreen (Full fidelity)"),
        ("custom", "Enter custom resolution manually")
    ]
    print("\nStep 3: Select resolution (imgsz):")
    for idx, (res, desc) in enumerate(res_presets, 1):
        print(f"  [{idx}] {desc}")

    res_choice = input(f"\nSelect resolution [1-{len(res_presets)}] (default: 1 [640]): ").strip()
    if res_choice == "5":
        raw_custom = input("Enter custom resolution (e.g. 960 or 736,1280): ").strip()
        selected_imgsz = parse_imgsz([raw_custom])
    elif res_choice in ["2", "3", "4"]:
        selected_imgsz = parse_imgsz([res_presets[int(res_choice) - 1][0]])
    else:
        selected_imgsz = 640
    print(f"--> Selected imgsz: {selected_imgsz}")

    # Dynamic shapes
    dyn_choice = input("\nStep 4: Enable dynamic input shapes? (Supports any size at runtime) [Y/n]: ").strip().lower()
    selected_dynamic = False if dyn_choice == "n" else True
    print(f"--> Dynamic: {selected_dynamic}")

    # Half precision
    half_choice = input("\nStep 5: Export with FP16 half precision? (Useful for GPUs, not CPU) [y/N]: ").strip().lower()
    selected_half = True if half_choice == "y" else False
    print(f"--> Half Precision (FP16): {selected_half}")

    # Run export
    export_model(
        model_path=selected_model,
        export_format=selected_format,
        imgsz=selected_imgsz,
        dynamic=selected_dynamic,
        half=selected_half
    )


def main():
    parser = argparse.ArgumentParser(description="Universal Model Exporter for YOLO Models (.pt -> ONNX, OpenVINO, TensorRT)")
    parser.add_argument("--model", type=str, default=None, help="Path to .pt model file (e.g. yolo26s.pt)")
    parser.add_argument("--format", type=str, default="onnx", choices=["onnx", "openvino", "engine", "torchscript", "tflite"], help="Export format (default: onnx)")
    parser.add_argument("--imgsz", nargs="+", default=None, help="Inference resolution. Square: --imgsz 1280. Rectangular 16:9: --imgsz 736 1280")
    parser.add_argument("--dynamic", action="store_true", default=True, help="Enable dynamic input shapes (default: True)")
    parser.add_argument("--fixed", dest="dynamic", action="store_false", help="Bake fixed input shape (disables dynamic)")
    parser.add_argument("--half", action="store_true", default=False, help="Export with FP16 half precision")
    parser.add_argument("--opset", type=int, default=19, help="ONNX opset version (default: 19)")
    parser.add_argument("--no-simplify", dest="simplify", action="store_false", default=True, help="Disable ONNX simplification")
    parser.add_argument("--list", action="store_true", help="List all local .pt models in the workspace and exit")

    args = parser.parse_args()

    if args.list:
        models = get_local_models()
        print("\n" + "=" * 50)
        print("LOCAL PYTORCH (.pt) MODELS IN WORKSPACE:")
        print("=" * 50)
        for idx, m in enumerate(models, 1):
            print(f"  [{idx}] {m:<30} ({format_size(os.path.getsize(m))})")
        print("=" * 50)
        return

    # If no model is specified via CLI, launch interactive wizard
    if args.model is None:
        interactive_wizard()
    else:
        imgsz = parse_imgsz(args.imgsz) if args.imgsz else 640
        export_model(
            model_path=args.model,
            export_format=args.format,
            imgsz=imgsz,
            dynamic=args.dynamic,
            half=args.half,
            opset=args.opset,
            simplify=args.simplify
        )


if __name__ == "__main__":
    main()
