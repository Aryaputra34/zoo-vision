import os
import cv2
from huggingface_hub import hf_hub_download
from ultralytics import YOLO
import supervision as sv

def main():
    upload_dir = r"C:\Users\Magnet Busdev-2\.gemini\antigravity-ide\brain\c361c378-df90-42cc-8642-77aea8b3eddd\.user_uploaded"
    img_busy_path = os.path.join(upload_dir, "media_1790058312916.jpg")
    img_sparse_path = os.path.join(upload_dir, "media_1790058289420.jpg")
    
    print("Testing keremberke/yolov8n-head-detection...")
    try:
        model_path = hf_hub_download(repo_id="keremberke/yolov8n-head-detection", filename="best.pt")
        model = YOLO(model_path)
    except Exception as e:
        print(f"Download failed: {e}")
        return

    # Busy Frame
    img_busy = cv2.imread(img_busy_path)
    for conf in [0.20, 0.25]:
        res = model(img_busy, conf=conf, imgsz=1280, verbose=False)[0]
        dets = sv.Detections.from_ultralytics(res)
        print(f"[Busy Frame] Head count at conf={conf}: {len(dets)}")
        
        # annotate
        annotated = img_busy.copy()
        box_ann = sv.BoxAnnotator(thickness=2)
        annotated = box_ann.annotate(annotated, detections=dets)
        cv2.imwrite(rf"c:\Users\Magnet Busdev-2\Documents\temp\zoo-monitor\scratch\head_busy_{conf}.jpg", annotated)

    # Sparse Frame
    img_sparse = cv2.imread(img_sparse_path)
    for conf in [0.15, 0.20]:
        res = model(img_sparse, conf=conf, imgsz=1280, verbose=False)[0]
        dets = sv.Detections.from_ultralytics(res)
        print(f"[Sparse Frame] Head count at conf={conf}: {len(dets)}")
        annotated = img_sparse.copy()
        box_ann = sv.BoxAnnotator(thickness=2)
        annotated = box_ann.annotate(annotated, detections=dets)
        cv2.imwrite(rf"c:\Users\Magnet Busdev-2\Documents\temp\zoo-monitor\scratch\head_sparse_{conf}.jpg", annotated)

if __name__ == "__main__":
    main()
