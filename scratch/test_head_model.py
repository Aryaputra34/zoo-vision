import os
import cv2
import urllib.request
from ultralytics import YOLO
import supervision as sv

def main():
    upload_dir = r"C:\Users\Magnet Busdev-2\.gemini\antigravity-ide\brain\c361c378-df90-42cc-8642-77aea8b3eddd\.user_uploaded"
    img_busy_path = os.path.join(upload_dir, "media_1790058312916.jpg")
    img_sparse_path = os.path.join(upload_dir, "media_1790058289420.jpg")
    
    model_path = r"c:\Users\Magnet Busdev-2\Documents\temp\zoo-monitor\scratch\yolov8n_head_detector.pt"
    if not os.path.exists(model_path):
        print("Downloading yolov8n_head_detector.pt...")
        url = "https://huggingface.co/abhiWanKenobi/yolov8n-head-detection/resolve/main/yolov8n_head_detector.pt"
        urllib.request.urlretrieve(url, model_path)
        print("Downloaded!")
    model = YOLO(model_path)
    
    # Test on busy image
    img_busy = cv2.imread(img_busy_path)
    res_busy = model(img_busy, conf=0.25, imgsz=1280, verbose=False)[0]
    dets_busy = sv.Detections.from_ultralytics(res_busy)
    print(f"[Busy Frame] Head detections count at 1280px: {len(dets_busy)}")
    
    # Test on sparse image
    img_sparse = cv2.imread(img_sparse_path)
    res_sparse = model(img_sparse, conf=0.20, imgsz=1280, verbose=False)[0]
    dets_sparse = sv.Detections.from_ultralytics(res_sparse)
    print(f"[Sparse Frame] Head detections count at 1280px: {len(dets_sparse)}")
    
    # Save visual comparison
    box_annotator = sv.BoxAnnotator(thickness=2)
    annotated = box_annotator.annotate(img_busy.copy(), detections=dets_busy)
    out_path = r"c:\Users\Magnet Busdev-2\Documents\temp\zoo-monitor\scratch\head_busy_preview.jpg"
    cv2.imwrite(out_path, annotated)
    print(f"Saved head detection preview to {out_path}")

if __name__ == "__main__":
    main()
