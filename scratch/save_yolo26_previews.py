import os
import cv2
from ultralytics import YOLO
import supervision as sv

def main():
    upload_dir = r"C:\Users\Magnet Busdev-2\.gemini\antigravity-ide\brain\c361c378-df90-42cc-8642-77aea8b3eddd\.user_uploaded"
    img_busy_path = os.path.join(upload_dir, "media_1790058312916.jpg")
    img_sparse_path = os.path.join(upload_dir, "media_1790058289420.jpg")
    
    y = YOLO("yolo26m.pt")
    
    # Busy
    img_busy = cv2.imread(img_busy_path)
    res_busy = y(img_busy, classes=[0], conf=0.22, imgsz=1280, verbose=False)[0]
    dets_busy = sv.Detections.from_ultralytics(res_busy)
    
    box_ann = sv.BoxAnnotator(thickness=2)
    lbl_ann = sv.LabelAnnotator(text_scale=0.4, text_thickness=1)
    
    ann_busy = box_ann.annotate(img_busy.copy(), detections=dets_busy)
    labels = [f"person {c:.2f}" for c in dets_busy.confidence]
    ann_busy = lbl_ann.annotate(ann_busy, detections=dets_busy, labels=labels)
    cv2.imwrite(r"c:\Users\Magnet Busdev-2\Documents\temp\zoo-monitor\scratch\yolo26m_busy.jpg", ann_busy)
    
    # Sparse
    img_sparse = cv2.imread(img_sparse_path)
    res_sparse = y(img_sparse, classes=[0], conf=0.15, imgsz=1280, verbose=False)[0]
    dets_sparse = sv.Detections.from_ultralytics(res_sparse)
    ann_sparse = box_ann.annotate(img_sparse.copy(), detections=dets_sparse)
    labels_sp = [f"person {c:.2f}" for c in dets_sparse.confidence]
    ann_sparse = lbl_ann.annotate(ann_sparse, detections=dets_sparse, labels=labels_sp)
    cv2.imwrite(r"c:\Users\Magnet Busdev-2\Documents\temp\zoo-monitor\scratch\yolo26m_sparse.jpg", ann_sparse)
    print("Saved yolo26m visualizations successfully!")

if __name__ == "__main__":
    main()
