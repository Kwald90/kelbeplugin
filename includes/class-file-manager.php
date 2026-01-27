<?php
/**
 * File Manager
 *
 * Handles file uploads and management
 *
 * @package Kelbe_Project_Tracker
 */

// Exit if accessed directly
if (!defined('ABSPATH')) {
    exit;
}

/**
 * File Manager class
 */
class KPT_File_Manager {
    
    /**
     * Single instance of the class
     *
     * @var KPT_File_Manager
     */
    private static $instance = null;
    
    /**
     * Get instance
     *
     * @return KPT_File_Manager
     */
    public static function get_instance() {
        if (null === self::$instance) {
            self::$instance = new self();
        }
        return self::$instance;
    }
    
    /**
     * Constructor
     */
    private function __construct() {
        add_action('wp_ajax_kpt_upload_file', array($this, 'ajax_upload_file'));
        add_action('wp_ajax_kpt_delete_file', array($this, 'ajax_delete_file'));
        add_action('wp_ajax_kpt_get_files', array($this, 'ajax_get_files'));
        add_action('wp_ajax_kpt_update_file', array($this, 'ajax_update_file'));
    }
    
    /**
     * Get files for a project
     *
     * @param int $project_id Project ID
     * @param int $folder_id Optional folder filter
     * @return array Files
     */
    public function get_files($project_id, $folder_id = null) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_files';
        
        $where = $wpdb->prepare('project_id = %d', $project_id);
        
        if ($folder_id !== null) {
            $where .= $wpdb->prepare(' AND folder_id = %d', $folder_id);
        } else {
            $where .= ' AND folder_id IS NULL';
        }
        
        $files = $wpdb->get_results("SELECT * FROM $table WHERE $where ORDER BY created_at DESC");
        
        // Enrich with uploader data
        foreach ($files as &$file) {
            if ($file->uploaded_by) {
                $user = get_userdata($file->uploaded_by);
                if ($user) {
                    $file->uploader_name = $user->display_name;
                }
            }
            
            // Add file size and icon
            $file->file_size = $this->format_file_size($file->file_url);
            $file->file_icon = $this->get_file_icon($file->file_type);
        }
        
        return $files;
    }
    
    /**
     * Get a single file
     *
     * @param int $file_id File ID
     * @return object|null File object or null
     */
    public function get_file($file_id) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_files';
        
        return $wpdb->get_row($wpdb->prepare("SELECT * FROM $table WHERE id = %d", $file_id));
    }
    
    /**
     * Add a file
     *
     * @param array $data File data
     * @return int|false File ID on success, false on failure
     */
    public function add_file($data) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_files';
        
        $defaults = array(
            'project_id' => 0,
            'folder_id' => null,
            'file_name' => '',
            'file_url' => '',
            'file_type' => '',
            'uploaded_by' => get_current_user_id(),
        );
        
        $data = wp_parse_args($data, $defaults);
        
        // Sanitize data
        $insert_data = array(
            'project_id' => absint($data['project_id']),
            'folder_id' => $data['folder_id'] ? absint($data['folder_id']) : null,
            'file_name' => sanitize_file_name($data['file_name']),
            'file_url' => esc_url_raw($data['file_url']),
            'file_type' => sanitize_text_field($data['file_type']),
            'uploaded_by' => absint($data['uploaded_by']),
            'created_at' => current_time('mysql'),
        );
        
        $result = $wpdb->insert($table, $insert_data);
        
        if ($result === false) {
            return false;
        }
        
        $file_id = $wpdb->insert_id;
        
        do_action('kpt_file_added', $file_id, $data);
        
        return $file_id;
    }
    
    /**
     * Update a file
     *
     * @param int $file_id File ID
     * @param array $data File data
     * @return bool True on success, false on failure
     */
    public function update_file($file_id, $data) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_files';
        
        $file = $this->get_file($file_id);
        if (!$file) {
            return false;
        }
        
        $update_data = array();
        
        if (isset($data['file_name'])) {
            $update_data['file_name'] = sanitize_file_name($data['file_name']);
        }
        
        if (isset($data['folder_id'])) {
            $update_data['folder_id'] = $data['folder_id'] ? absint($data['folder_id']) : null;
        }
        
        $result = $wpdb->update($table, $update_data, array('id' => $file_id));
        
        if ($result !== false) {
            do_action('kpt_file_updated', $file_id, $data);
        }
        
        return $result !== false;
    }
    
    /**
     * Delete a file
     *
     * @param int $file_id File ID
     * @param bool $delete_physical Whether to delete the physical file
     * @return bool True on success, false on failure
     */
    public function delete_file($file_id, $delete_physical = true) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_files';
        
        $file = $this->get_file($file_id);
        if (!$file) {
            return false;
        }
        
        // Delete physical file if requested
        if ($delete_physical) {
            $upload_dir = wp_upload_dir();
            $file_path = str_replace($upload_dir['baseurl'], $upload_dir['basedir'], $file->file_url);
            
            if (file_exists($file_path)) {
                wp_delete_file($file_path);
            }
        }
        
        $result = $wpdb->delete($table, array('id' => $file_id), array('%d'));
        
        if ($result !== false) {
            do_action('kpt_file_deleted', $file_id, $file);
        }
        
        return $result !== false;
    }
    
    /**
     * Handle file upload
     *
     * @param array $file $_FILES array element
     * @param int $project_id Project ID
     * @param int $folder_id Optional folder ID
     * @return array Result with success/error
     */
    public function handle_upload($file, $project_id, $folder_id = null) {
        // Check file size
        $max_size = wp_max_upload_size();
        if ($file['size'] > $max_size) {
            return array(
                'success' => false,
                'message' => sprintf(__('File size exceeds maximum allowed size of %s.', 'kelbe-project-tracker'), size_format($max_size)),
            );
        }
        
        // Check file type
        $allowed_types = $this->get_allowed_file_types();
        $file_type = wp_check_filetype($file['name']);
        
        if (!in_array($file_type['ext'], $allowed_types)) {
            return array(
                'success' => false,
                'message' => __('File type not allowed.', 'kelbe-project-tracker'),
            );
        }
        
        // Upload file
        require_once(ABSPATH . 'wp-admin/includes/file.php');
        
        $upload_overrides = array('test_form' => false);
        $movefile = wp_handle_upload($file, $upload_overrides);
        
        if ($movefile && !isset($movefile['error'])) {
            // Add to database
            $file_id = $this->add_file(array(
                'project_id' => $project_id,
                'folder_id' => $folder_id,
                'file_name' => $file['name'],
                'file_url' => $movefile['url'],
                'file_type' => $file_type['ext'],
            ));
            
            if ($file_id) {
                return array(
                    'success' => true,
                    'message' => __('File uploaded successfully.', 'kelbe-project-tracker'),
                    'file_id' => $file_id,
                    'file' => $this->get_file($file_id),
                );
            } else {
                // Clean up uploaded file if database insert fails
                wp_delete_file($movefile['file']);
                
                return array(
                    'success' => false,
                    'message' => __('Failed to save file information.', 'kelbe-project-tracker'),
                );
            }
        } else {
            return array(
                'success' => false,
                'message' => $movefile['error'],
            );
        }
    }
    
    /**
     * Get allowed file types
     *
     * @return array Allowed file extensions
     */
    private function get_allowed_file_types() {
        $allowed = array(
            // Images
            'jpg', 'jpeg', 'png', 'gif', 'webp',
            // Documents
            'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
            // Other
            'txt', 'csv', 'zip', 'rar',
        );
        
        return apply_filters('kpt_allowed_file_types', $allowed);
    }
    
    /**
     * Format file size
     *
     * @param string $file_url File URL
     * @return string Formatted file size
     */
    private function format_file_size($file_url) {
        $upload_dir = wp_upload_dir();
        $file_path = str_replace($upload_dir['baseurl'], $upload_dir['basedir'], $file_url);
        
        if (file_exists($file_path)) {
            return size_format(filesize($file_path));
        }
        
        return __('Unknown', 'kelbe-project-tracker');
    }
    
    /**
     * Get file icon
     *
     * @param string $file_type File type
     * @return string Icon class or URL
     */
    private function get_file_icon($file_type) {
        $icons = array(
            'pdf' => 'dashicons-pdf',
            'doc' => 'dashicons-media-document',
            'docx' => 'dashicons-media-document',
            'xls' => 'dashicons-media-spreadsheet',
            'xlsx' => 'dashicons-media-spreadsheet',
            'ppt' => 'dashicons-media-interactive',
            'pptx' => 'dashicons-media-interactive',
            'jpg' => 'dashicons-format-image',
            'jpeg' => 'dashicons-format-image',
            'png' => 'dashicons-format-image',
            'gif' => 'dashicons-format-image',
            'webp' => 'dashicons-format-image',
            'zip' => 'dashicons-media-archive',
            'rar' => 'dashicons-media-archive',
        );
        
        return isset($icons[$file_type]) ? $icons[$file_type] : 'dashicons-media-default';
    }
    
    /**
     * Get project storage usage
     *
     * @param int $project_id Project ID
     * @return array Storage information
     */
    public function get_storage_usage($project_id) {
        $files = $this->get_files($project_id);
        $upload_dir = wp_upload_dir();
        
        $total_size = 0;
        $file_count = count($files);
        
        foreach ($files as $file) {
            $file_path = str_replace($upload_dir['baseurl'], $upload_dir['basedir'], $file->file_url);
            if (file_exists($file_path)) {
                $total_size += filesize($file_path);
            }
        }
        
        return array(
            'file_count' => $file_count,
            'total_size' => $total_size,
            'formatted_size' => size_format($total_size),
        );
    }
    
    /**
     * AJAX: Upload file
     */
    public function ajax_upload_file() {
        check_ajax_referer('kpt_nonce', 'nonce');
        
        $project_id = isset($_POST['project_id']) ? absint($_POST['project_id']) : 0;
        
        if (!$project_id || !$this->user_can_manage_files($project_id)) {
            wp_send_json_error(__('Permission denied.', 'kelbe-project-tracker'));
        }
        
        if (empty($_FILES['file'])) {
            wp_send_json_error(__('No file uploaded.', 'kelbe-project-tracker'));
        }
        
        $folder_id = isset($_POST['folder_id']) ? absint($_POST['folder_id']) : null;
        
        $result = $this->handle_upload($_FILES['file'], $project_id, $folder_id);
        
        if ($result['success']) {
            wp_send_json_success($result);
        } else {
            wp_send_json_error($result['message']);
        }
    }
    
    /**
     * AJAX: Delete file
     */
    public function ajax_delete_file() {
        check_ajax_referer('kpt_nonce', 'nonce');
        
        $file_id = isset($_POST['file_id']) ? absint($_POST['file_id']) : 0;
        $file = $this->get_file($file_id);
        
        if (!$file || !$this->user_can_manage_files($file->project_id)) {
            wp_send_json_error(__('Permission denied.', 'kelbe-project-tracker'));
        }
        
        if ($this->delete_file($file_id)) {
            wp_send_json_success(__('File deleted.', 'kelbe-project-tracker'));
        } else {
            wp_send_json_error(__('Failed to delete file.', 'kelbe-project-tracker'));
        }
    }
    
    /**
     * AJAX: Get files
     */
    public function ajax_get_files() {
        check_ajax_referer('kpt_nonce', 'nonce');
        
        $project_id = isset($_POST['project_id']) ? absint($_POST['project_id']) : 0;
        
        if (!$project_id) {
            wp_send_json_error(__('Project ID is required.', 'kelbe-project-tracker'));
        }
        
        $folder_id = isset($_POST['folder_id']) ? absint($_POST['folder_id']) : null;
        $files = $this->get_files($project_id, $folder_id);
        
        wp_send_json_success($files);
    }
    
    /**
     * AJAX: Update file
     */
    public function ajax_update_file() {
        check_ajax_referer('kpt_nonce', 'nonce');
        
        $file_id = isset($_POST['file_id']) ? absint($_POST['file_id']) : 0;
        $file = $this->get_file($file_id);
        
        if (!$file || !$this->user_can_manage_files($file->project_id)) {
            wp_send_json_error(__('Permission denied.', 'kelbe-project-tracker'));
        }
        
        $data = array();
        
        if (isset($_POST['file_name'])) {
            $data['file_name'] = sanitize_file_name($_POST['file_name']);
        }
        
        if (isset($_POST['folder_id'])) {
            $data['folder_id'] = absint($_POST['folder_id']);
        }
        
        if ($this->update_file($file_id, $data)) {
            wp_send_json_success(array(
                'message' => __('File updated.', 'kelbe-project-tracker'),
                'file' => $this->get_file($file_id),
            ));
        } else {
            wp_send_json_error(__('Failed to update file.', 'kelbe-project-tracker'));
        }
    }
    
    /**
     * Check if user can manage files for a project
     *
     * @param int $project_id Project ID
     * @return bool True if user can manage, false otherwise
     */
    private function user_can_manage_files($project_id) {
        $user_id = get_current_user_id();
        
        // Admins can always manage
        if (current_user_can('manage_options')) {
            return true;
        }
        
        // Project author can manage
        $project = get_post($project_id);
        if ($project && $project->post_author == $user_id) {
            return true;
        }
        
        // Team members can manage
        $team_manager = KPT_Team_Manager::get_instance();
        $member = $team_manager->get_team_member($project_id, $user_id);
        
        return (bool) $member;
    }
}
